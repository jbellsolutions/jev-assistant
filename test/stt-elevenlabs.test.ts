import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ElevenLabsSpeechProvider, type SttSocket } from "../server/stt/elevenlabs.js";
import { selectSttProvider } from "../server/stt/select.js";
import type { SttEvent, SttStart } from "../server/stt/types.js";

const start: SttStart = { sampleRate: 16000, encoding: "pcm_s16le", channels: 1, lang: "en-US", keywords: ["Jev", "Hermes"] };

/** A fake ElevenLabs socket: captures what we send, lets the test push server frames back. */
function fakeSocket() {
  class Sock extends EventEmitter implements SttSocket {
    readyState = 1;
    sent: string[] = [];
    closed = 0;
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.closed++;
      queueMicrotask(() => this.emit("close"));
    }
  }
  const ws = new Sock();
  return {
    ws,
    say: (obj: unknown) => ws.emit("message", JSON.stringify(obj)),
    frames: () => ws.sent.map((s) => JSON.parse(s) as Record<string, unknown>),
  };
}

function connectTo(fake: ReturnType<typeof fakeSocket>) {
  let seen: { url: string; headers: Record<string, string> } | null = null;
  const provider = new ElevenLabsSpeechProvider({
    apiKey: "sk-test",
    connect: (url, headers) => {
      seen = { url, headers };
      queueMicrotask(() => fake.ws.emit("open"));
      return fake.ws;
    },
  });
  return { provider, seen: () => seen };
}

describe("ElevenLabsSpeechProvider", () => {
  it("opens the documented realtime endpoint with manual commit, the api key header and keyterms", async () => {
    const fake = fakeSocket();
    const { provider, seen } = connectTo(fake);
    provider.open(start, () => {});
    await new Promise((r) => setTimeout(r, 5));

    const url = new URL(seen()!.url);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    expect(url.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(url.searchParams.get("audio_format")).toBe("pcm_16000");
    // push-to-talk: the client decides when the turn ends, never a silence timer
    expect(url.searchParams.get("commit_strategy")).toBe("manual");
    // a language code, not a locale
    expect(url.searchParams.get("language_code")).toBe("en");
    expect(url.searchParams.getAll("keyterms")).toEqual(["Jev", "Hermes"]);
    expect(seen()!.headers).toEqual({ "xi-api-key": "sk-test" });
  });

  it("maps server frames to events, always reporting speechFinal:false", async () => {
    const fake = fakeSocket();
    const { provider } = connectTo(fake);
    const events: SttEvent[] = [];
    provider.open(start, (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 5));

    fake.say({ message_type: "session_started" });
    fake.say({ message_type: "partial_transcript", text: "open wiki" });
    fake.say({ message_type: "committed_transcript", text: "Open Wikipedia." });

    expect(events).toEqual([
      { type: "open" },
      { type: "transcript", text: "open wiki", final: false, speechFinal: false },
      // committed = stable text, NOT end of turn. speechFinal must stay false or a mid-sentence
      // pause dispatches half a command again (the M5.5 bug).
      { type: "transcript", text: "Open Wikipedia.", final: true, speechFinal: false },
    ]);
  });

  it("base64-frames audio and commits only on finish()", async () => {
    const fake = fakeSocket();
    const { provider } = connectTo(fake);
    const stream = provider.open(start, () => {});
    await new Promise((r) => setTimeout(r, 5));

    stream.send(new Uint8Array([1, 2, 3, 4]));
    expect(fake.frames()).toEqual([{ message_type: "input_audio_chunk", audio_base_64: Buffer.from([1, 2, 3, 4]).toString("base64"), commit: false, sample_rate: 16000 }]);

    stream.finish();
    expect(fake.frames().at(-1)).toMatchObject({ commit: true, audio_base_64: "" });
  });

  it("queues audio sent before the socket opens, then flushes it in order", async () => {
    const fake = fakeSocket();
    let fire: (() => void) | null = null;
    const provider = new ElevenLabsSpeechProvider({
      apiKey: "k",
      connect: () => {
        fire = () => fake.ws.emit("open");
        return fake.ws;
      },
    });
    const stream = provider.open(start, () => {});
    stream.send(new Uint8Array([1]));
    stream.send(new Uint8Array([2]));
    expect(fake.ws.sent).toHaveLength(0);
    fire!();
    expect(fake.frames().map((f) => f.audio_base_64)).toEqual([Buffer.from([1]).toString("base64"), Buffer.from([2]).toString("base64")]);
  });

  it("closes the socket once the flush after finish() arrives", async () => {
    const fake = fakeSocket();
    const { provider } = connectTo(fake);
    const events: SttEvent[] = [];
    const stream = provider.open(start, (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 5));

    fake.say({ message_type: "committed_transcript", text: "early" });
    expect(fake.ws.closed).toBe(0); // not finishing yet — keep listening

    stream.finish();
    fake.say({ message_type: "committed_transcript", text: "tail" });
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.ws.closed).toBe(1);
    expect(events.at(-1)).toEqual({ type: "closed" });
  });

  it("surfaces auth and quota failures as errors", async () => {
    for (const kind of ["error", "auth_error", "quota_exceeded", "rate_limited"]) {
      const fake = fakeSocket();
      const { provider } = connectTo(fake);
      const events: SttEvent[] = [];
      provider.open(start, (e) => events.push(e));
      await new Promise((r) => setTimeout(r, 5));
      fake.say({ message_type: kind, error: "nope" });
      expect(events.at(-1)).toEqual({ type: "error", message: "nope" });
    }
  });

  it("refuses a sample rate the API does not accept, without opening a socket", async () => {
    let connected = false;
    const provider = new ElevenLabsSpeechProvider({
      apiKey: "k",
      connect: () => {
        connected = true;
        return fakeSocket().ws;
      },
    });
    const events: SttEvent[] = [];
    provider.open({ ...start, sampleRate: 12345 }, (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 5));
    expect(connected).toBe(false);
    expect(events.map((e) => e.type)).toEqual(["error", "closed"]);
  });
});

describe("selectSttProvider", () => {
  const noApple = { appleBin: "/definitely/not/here" };

  it("prefers ElevenLabs when it has a key", () => {
    expect(selectSttProvider({ ELEVENLABS_API_KEY: "k" } as NodeJS.ProcessEnv, noApple)?.name).toBe("elevenlabs");
  });

  it("returns nothing when no engine is available", () => {
    expect(selectSttProvider({} as NodeJS.ProcessEnv, noApple)).toBeNull();
  });

  it("honours STT_PROVIDER=off even with a key present", () => {
    expect(selectSttProvider({ ELEVENLABS_API_KEY: "k", STT_PROVIDER: "off" } as NodeJS.ProcessEnv, noApple)).toBeNull();
  });

  it("honours STT_PROVIDER=apple, and returns nothing when the helper is missing", () => {
    expect(selectSttProvider({ ELEVENLABS_API_KEY: "k", STT_PROVIDER: "apple" } as NodeJS.ProcessEnv, noApple)).toBeNull();
  });
});
