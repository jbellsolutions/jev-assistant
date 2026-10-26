/** Bridges one UI microphone socket (/ws/stt) to the STT provider. One relay per socket; the
 *  provider stream lives from `start` to `stop`. True push-to-talk (the client controls
 *  start/stop) needs no silence-driven auto-flush timer — but accumulating every `final`
 *  fragment until the explicit stop is NOT optional: the provider (server/stt/apple.ts) recycles
 *  its own recognition request roughly every ~700ms of silence, so a single utterance with a
 *  couple of natural pauses arrives as several separate finals, not one. Keeping only the last
 *  would silently truncate it. */
import { STT_FINISH_TIMEOUT_MS, type SttClientMessage, type SttServerMessage } from "../../core/protocol.js";
import { WAKE_KEYWORDS } from "../../core/wake.js";
import type { SttProvider, SttStream } from "./types.js";
import { WakeSession } from "./wake-relay.js";

/** What the relay needs from a socket: the `ws` API subset, so tests can use real pairs. */
export interface RelaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (data: unknown, isBinary: boolean) => void): void;
  on(event: "close", cb: () => void): void;
}

export interface RelayOptions {
  provider: SttProvider;
  /** Wake mode's always-on listener (free, on-device). Without one, `mode: "wake"` is refused
   *  rather than silently falling back to billing a cloud engine to listen to an empty room. */
  listener?: SttProvider | null;
  /** After `stop`, how long to wait for the provider's last finals before flushing anyway. */
  finishTimeoutMs?: number;
  /** Called for every complete utterance, after it was sent to the UI. */
  onUtterance?: (text: string) => void;
  /** True while Jev's own voice is coming out of the speaker (server/speak/gate.ts). Audio that
   *  arrives while this holds is discarded rather than transcribed — otherwise she hears her own
   *  reply, decides it was a command, and answers herself. Checked here, in-process, because the
   *  renderer round trip is itself the window in which she would hear herself. */
  deaf?: () => boolean;
  /** Switched off. Nothing is heard at all — not transcribed, and not even buffered, so a paused
   *  minute cannot be replayed to a metered engine when Jev is switched back on. */
  paused?: () => boolean;
  /** Say "Yes?" when a bare wake word is heard — see WakeRelayOptions.onWake for why the server
   *  says it rather than the panel. */
  onWake?: () => void;
}

const OPEN = 1;
const MAX_SAMPLE_RATE = 48_000;

export function attachSttRelay(ws: RelaySocket, opts: RelayOptions): void {
  let stream: SttStream | null = null;
  let wake: WakeSession | null = null;
  let current: object | null = null; // identity token: is this callback still the active stream's?
  let finals: string[] = [];
  let interim = "";
  let finishGuard: ReturnType<typeof setTimeout> | undefined;

  const send = (msg: SttServerMessage) => {
    if (ws.readyState === OPEN) ws.send(JSON.stringify(msg));
  };
  const pendingText = () => [...finals, interim].filter(Boolean).join(" ");
  const flush = () => {
    const text = finals.join(" ").trim();
    finals = [];
    interim = "";
    if (text) {
      send({ type: "utterance", text });
      send({ type: "transcript", text: "", final: false });
      opts.onUtterance?.(text);
    }
  };
  const teardown = () => {
    clearTimeout(finishGuard);
    finishGuard = undefined;
    stream = null;
    current = null;
  };
  /** Immediate: the UI went away or restarted the stream. */
  const abort = () => {
    wake?.close();
    wake = null;
    stream?.close();
    finals = [];
    interim = "";
    teardown();
  };
  /** Graceful: ask the provider to flush, keep collecting until it closes (or a guard fires). */
  const finish = () => {
    const s = stream;
    if (!s) return;
    s.finish();
    finishGuard = setTimeout(() => {
      flush();
      send({ type: "closed" });
      abort();
    }, opts.finishTimeoutMs ?? STT_FINISH_TIMEOUT_MS);
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const chunk = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      // Drop the frames outright rather than transcribing and discarding: a cloud provider bills
      // for audio it receives, and Jev talking to herself is the most expensive silence there is.
      if (opts.paused?.()) return;
      if (wake) wake.send(chunk);
      else if (stream && !opts.deaf?.()) stream.send(chunk);
      return;
    }
    let msg: SttClientMessage;
    try {
      msg = JSON.parse(String(data)) as SttClientMessage;
    } catch {
      return send({ type: "error", message: "bad message" });
    }
    if (msg.type === "start") {
      if (stream) abort();
      const sampleRate = Number(msg.sampleRate);
      if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > MAX_SAMPLE_RATE || msg.encoding !== "pcm_s16le" || msg.channels !== 1) {
        return send({ type: "error", message: "unsupported audio format: send mono pcm_s16le at 8–48 kHz" });
      }
      finals = [];
      interim = "";

      // Wake mode: the relay owns the boundary, and two engines share the job — see
      // server/stt/wake-relay.ts. Refused outright without an on-device listener, because the
      // fallback would be billing a cloud engine to listen to an empty room.
      if (msg.mode === "wake") {
        const listener = opts.listener;
        if (!listener) return send({ type: "error", message: "wake mode needs the on-device recogniser — run npm run build:native, or use the mic button" });
        wake = new WakeSession(
          {
            listener,
            transcriber: opts.provider === listener ? null : opts.provider,
            send,
            ...(opts.deaf ? { deaf: opts.deaf } : {}),
            ...(opts.onWake ? { onWake: opts.onWake } : {}),
          },
          { sampleRate, lang: msg.lang, keywords: [...WAKE_KEYWORDS, ...(msg.keywords ?? [])] },
        );
        wake.open();
        return;
      }

      const token = {};
      current = token;
      const s = opts.provider.open({ sampleRate, encoding: "pcm_s16le", channels: 1, lang: msg.lang, keywords: msg.keywords }, (ev) => {
        if (current !== token) return; // a later start replaced this stream
        switch (ev.type) {
          case "open":
            send({ type: "ready", provider: opts.provider.name });
            break;
          case "error":
            send({ type: "error", message: ev.message });
            break;
          case "closed":
            flush();
            send({ type: "closed" });
            teardown();
            break;
          case "utterance_end":
            flush();
            break;
          case "transcript": {
            // A recognition already in flight when Jev started speaking can still deliver her
            // words after the frames stopped, so the gate is checked on the way out too.
            if (opts.deaf?.()) break;
            const text = ev.text.trim();
            if (ev.final) {
              interim = "";
              if (text) finals.push(text);
            } else {
              interim = text;
            }
            send({ type: "transcript", text: pendingText(), final: false });
            break;
          }
        }
      });
      stream = s;
    } else if (msg.type === "stop") {
      finish();
    }
  });
  ws.on("close", abort);
}
