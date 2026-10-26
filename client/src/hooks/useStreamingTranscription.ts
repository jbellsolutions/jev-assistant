import { useCallback, useEffect, useRef, useState } from "react";
import type { SttClientMessage, SttMode, SttServerMessage } from "../../../core/protocol.ts";
import { Outbox, STOP_FLUSH_MS } from "../audio/outbox.ts";
import { Framer, PCM_WORKLET_SOURCE, floatTo16BitPCM, resample } from "../audio/pcm16.ts";
import type { Transport } from "../transport.ts";

const TARGET_RATE = 16000;
const FRAME_MS = 100;

export type VoiceAvailability = "ok" | "unsupported" | "insecure" | "no-mic";

export interface StreamingOptions {
  transport: Transport;
  onUtterance: (text: string) => void;
  lang?: string;
  keywords?: string[];
  /** "push" is the button (the client owns start and stop); "wake" leaves the microphone open and
   *  lets the server decide what was meant for Jev. Changing it restarts the stream. */
  mode?: SttMode;
}

interface Capture {
  stream: MediaStream;
  ctx: AudioContext;
  node: AudioWorkletNode;
  source: MediaStreamAudioSourceNode;
}

/** Microphone → 16 kHz PCM frames → /ws/stt → transcripts. Only complete utterances reach
 *  `onUtterance`; interim text is for display. In push mode the caller decides start/stop and there
 *  is no auto-flush on a silent gap; in wake mode the socket stays open and the server owns the
 *  boundary, emitting an utterance only after it has heard the name (see stt/wake-relay.ts). */
export function useStreamingTranscription(opts: StreamingOptions) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  /** Wake mode: a bare "Hey Jev" was heard and she answered — the panel shows it is her turn to
   *  be told something. Cleared when the command arrives, or when nothing follows. */
  const [woken, setWoken] = useState(false);
  const wokenTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wsRef = useRef<WebSocket | null>(null);
  const outboxRef = useRef<Outbox | null>(null);
  const captureRef = useRef<Capture | null>(null);
  const startingRef = useRef(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const availability: VoiceAvailability =
    typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined"
      ? "unsupported"
      : !window.isSecureContext
        ? "insecure"
        : "ok";

  const releaseCapture = useCallback(() => {
    const c = captureRef.current;
    captureRef.current = null;
    if (c) {
      c.node.port.onmessage = null;
      c.node.disconnect();
      c.source.disconnect();
      for (const t of c.stream.getTracks()) t.stop();
      void c.ctx.close().catch(() => {});
    }
  }, []);

  const teardown = useCallback(() => {
    startingRef.current = false;
    outboxRef.current = null;
    releaseCapture();
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    setListening(false);
    setInterim("");
    setWoken(false);
    clearTimeout(wokenTimer.current);
  }, [releaseCapture]);

  const stop = useCallback(() => {
    // The outbox sends `stop` now, or as soon as the socket opens if the key came up first.
    outboxRef.current?.stop();
    // The microphone is released at once, so the next press starts cleanly; only this socket
    // lingers, draining, until the server says `closed` (its last words flushed). The timer is the
    // backstop, longer than the relay's own guard so the flush always arrives first.
    releaseCapture();
    const ws = wsRef.current;
    wsRef.current = null;
    outboxRef.current = null;
    if (ws) {
      const backstop = setTimeout(() => ws.close(), STOP_FLUSH_MS);
      ws.addEventListener("close", () => clearTimeout(backstop));
    }
    setListening(false);
  }, [releaseCapture]);

  const start = useCallback(async () => {
    // `captureRef` is only set after two awaits (getUserMedia, then the worklet module), so it
    // cannot guard re-entry on its own: in wake mode an effect can call start() twice before the
    // first one has anything to show, and that opens two microphones, two sockets and two helpers —
    // the wake word heard twice, and the room billed twice.
    if (availability !== "ok" || captureRef.current || startingRef.current) return;
    startingRef.current = true;
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      setError(name === "NotAllowedError" ? "Microphone permission was denied. Allow it and try again." : name === "NotFoundError" ? "No microphone found." : `Microphone error: ${err instanceof Error ? err.message : String(err)}`);
      startingRef.current = false;
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: TARGET_RATE });
    } catch {
      ctx = new AudioContext();
    }
    const blob = new Blob([PCM_WORKLET_SOURCE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(url);
    } catch (err) {
      startingRef.current = false;
      setError(`Could not start audio capture: ${err instanceof Error ? err.message : String(err)}`);
      for (const t of stream.getTracks()) t.stop();
      void ctx.close().catch(() => {});
      return;
    } finally {
      URL.revokeObjectURL(url);
    }
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "jev-capture", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    source.connect(node);
    const framer = new Framer((TARGET_RATE * FRAME_MS) / 1000);
    const ws = new WebSocket(optsRef.current.transport.wsUrl("/ws/stt"));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    const outbox = new Outbox((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(d);
    });
    outboxRef.current = outbox;
    captureRef.current = { stream, ctx, node, source };
    startingRef.current = false;
    setListening(true);

    // Frames recorded while the socket is still opening wait in the outbox instead of being dropped.
    node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      const samples = resample(ev.data, ctx.sampleRate, TARGET_RATE);
      const pcm = floatTo16BitPCM(samples);
      for (const frame of framer.push(pcm)) outbox.frame(frame.buffer as ArrayBuffer);
    };
    ws.onopen = () => {
      const startMsg: SttClientMessage = {
        type: "start",
        sampleRate: TARGET_RATE,
        encoding: "pcm_s16le",
        channels: 1,
        lang: optsRef.current.lang ?? navigator.language ?? "en-US",
        keywords: optsRef.current.keywords ?? ["Jev"],
        ...(optsRef.current.mode ? { mode: optsRef.current.mode } : {}),
      };
      outbox.open(JSON.stringify(startMsg));
    };
    ws.onmessage = (ev) => {
      let msg: SttServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as SttServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case "ready":
          setProvider(msg.provider);
          break;
        case "transcript":
          setInterim(msg.text);
          break;
        case "utterance":
          setInterim("");
          setWoken(false);
          clearTimeout(wokenTimer.current);
          optsRef.current.onUtterance(msg.text);
          break;
        case "wake":
          setWoken(true);
          clearTimeout(wokenTimer.current);
          // The server's own window for the follow-up is WAKE_WINDOW_MS; this is only the label.
          wokenTimer.current = setTimeout(() => setWoken(false), 6000);
          break;
        case "error":
          setError(msg.message);
          break;
        case "closed":
          if (wsRef.current === ws) teardown();
          else ws.close(); // a released press, drained: its words were delivered above
          break;
      }
    };
    ws.onclose = (ev) => {
      if (wsRef.current !== ws) return;
      if (ev.code === 1013) setError("The server has no speech-to-text provider configured.");
      else if (captureRef.current) setError("Transcription connection closed.");
      teardown();
    };
    ws.onerror = () => {
      if (wsRef.current === ws) setError("Could not reach the transcription relay.");
    };
  }, [availability, teardown]);

  const toggle = useCallback(() => (captureRef.current ? stop() : void start()), [start, stop]);

  useEffect(() => teardown, [teardown]);

  // `close` is the immediate release (no flush window); `stop` is the polite one that waits for the
  // server's last utterance. A mode change or a pause wants the former.
  return { availability, listening, interim, error, provider, woken, start: () => void start(), stop, close: teardown, toggle };
}
