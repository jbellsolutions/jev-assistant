/** ElevenLabs Scribe v2 Realtime over a WebSocket. Cloud, ~$0.39/hr, and materially more
 *  accurate than Apple's on-device recognizer — especially on proper nouns, which is what
 *  `keyterms` boosts.
 *
 *  `commit_strategy=manual` is deliberate: the client decides when a turn ends (push-to-talk),
 *  not a silence timer. Like the Apple provider, every transcript is reported with
 *  `speechFinal: false` — a committed segment is a stable piece of text, NOT the user finishing
 *  their turn — so the relay keeps accumulating until the explicit stop. Reporting speechFinal
 *  here would resurrect the M5.5 bug where a mid-sentence pause dispatched half a command. */
import { WebSocket } from "ws";
import type { SttEvent, SttProvider, SttStart, SttStream } from "./types.js";

const ENDPOINT = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const DEFAULT_MODEL = "scribe_v2_realtime";
const OPEN = 1;
/** The formats the API accepts; anything else is rejected before we open a socket. */
const RATES = new Set([8000, 16000, 22050, 24000, 44100, 48000]);

/** The slice of `ws` this provider uses, so tests can pass a fake socket. */
export interface SttSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "close", cb: () => void): void;
}

export interface ElevenLabsSttOptions {
  apiKey: string;
  modelId?: string;
  /** Test seam; defaults to a real `ws` client. */
  connect?: (url: string, headers: Record<string, string>) => SttSocket;
}

interface ServerMessage {
  message_type?: string;
  text?: string;
  error?: string;
  message?: string;
}

export function elevenLabsAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.ELEVENLABS_API_KEY?.trim();
}

export class ElevenLabsSpeechProvider implements SttProvider {
  readonly name = "elevenlabs";

  constructor(private readonly opts: ElevenLabsSttOptions) {}

  private url(start: SttStart): string {
    const q = new URLSearchParams();
    q.set("model_id", this.opts.modelId ?? DEFAULT_MODEL);
    q.set("audio_format", `pcm_${start.sampleRate}`);
    q.set("commit_strategy", "manual");
    // the API wants a language code, not a locale: "en-US" -> "en"
    if (start.lang) q.set("language_code", start.lang.split("-")[0]!);
    for (const k of start.keywords ?? []) q.append("keyterms", k);
    return `${ENDPOINT}?${q}`;
  }

  open(start: SttStart, onEvent: (ev: SttEvent) => void): SttStream {
    if (!RATES.has(start.sampleRate)) {
      queueMicrotask(() => {
        onEvent({ type: "error", message: `ElevenLabs does not accept ${start.sampleRate} Hz audio` });
        onEvent({ type: "closed" });
      });
      return { send: () => {}, finish: () => {}, close: () => {} };
    }

    let closed = false;
    let opened = false;
    let committing = false;
    const backlog: string[] = [];
    const done = (ev: SttEvent) => {
      if (closed) return;
      closed = true;
      onEvent(ev);
    };

    let ws: SttSocket;
    try {
      const connect = this.opts.connect ?? ((url, headers) => new WebSocket(url, { headers }) as unknown as SttSocket);
      ws = connect(this.url(start), { "xi-api-key": this.opts.apiKey });
    } catch (err) {
      queueMicrotask(() => {
        onEvent({ type: "error", message: `cannot reach ElevenLabs: ${err instanceof Error ? err.message : String(err)}` });
        onEvent({ type: "closed" });
      });
      return { send: () => {}, finish: () => {}, close: () => {} };
    }

    const post = (frame: string) => {
      if (closed) return;
      if (opened && ws.readyState === OPEN) ws.send(frame);
      else backlog.push(frame);
    };
    const chunk = (audio: Uint8Array | null, commit: boolean) =>
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: audio ? Buffer.from(audio).toString("base64") : "",
        commit,
        sample_rate: start.sampleRate,
      });

    ws.on("open", () => {
      opened = true;
      for (const frame of backlog.splice(0)) if (ws.readyState === OPEN) ws.send(frame);
    });
    ws.on("message", (raw: unknown) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(raw)) as ServerMessage;
      } catch {
        return;
      }
      switch (msg.message_type) {
        case "session_started":
          onEvent({ type: "open" });
          break;
        case "partial_transcript":
          onEvent({ type: "transcript", text: msg.text ?? "", final: false, speechFinal: false });
          break;
        case "committed_transcript":
          // stable text, NOT end of turn — see the file header.
          onEvent({ type: "transcript", text: msg.text ?? "", final: true, speechFinal: false });
          // the client already asked to stop; this was the flush we were waiting for
          if (committing) ws.close();
          break;
        case "error":
        case "auth_error":
        case "quota_exceeded":
        case "rate_limited":
          onEvent({ type: "error", message: msg.error ?? msg.message ?? `ElevenLabs ${msg.message_type}` });
          break;
      }
    });
    ws.on("error", (err: Error) => done({ type: "error", message: err.message }));
    ws.on("close", () => done({ type: "closed" }));

    return {
      send: (audio) => post(chunk(audio, false)),
      finish: () => {
        committing = true;
        post(chunk(null, true));
      },
      close: () => {
        if (!closed) ws.close();
      },
    };
  }
}
