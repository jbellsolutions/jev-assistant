import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { SttServerMessage } from "../core/protocol.js";
import { attachSttRelay } from "../server/stt/relay.js";
import type { SttEvent, SttProvider, SttStart, SttStream } from "../server/stt/types.js";

class FakeProvider implements SttProvider {
  readonly name = "fake";
  starts: SttStart[] = [];
  audio: Uint8Array[] = [];
  finished = 0;
  closed = 0;
  emit: ((ev: SttEvent) => void) | null = null;
  open(start: SttStart, onEvent: (ev: SttEvent) => void): SttStream {
    this.starts.push(start);
    this.emit = onEvent;
    queueMicrotask(() => onEvent({ type: "open" }));
    return {
      send: (a) => this.audio.push(a),
      finish: () => {
        this.finished++;
        // a real provider flushes its last final and then closes
        setTimeout(() => {
          onEvent({ type: "transcript", text: "tail", final: true, speechFinal: false });
          onEvent({ type: "closed" });
        }, 20);
      },
      close: () => this.closed++,
    };
  }
}

let servers: WebSocketServer[] = [];
let sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets) ws.terminate();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
  sockets = [];
});

async function pair(provider: SttProvider, finishTimeoutMs = 200, deaf?: () => boolean, extra: { listener?: SttProvider; onWake?: () => void; paused?: () => boolean } = {}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  const utterances: string[] = [];
  wss.on("connection", (ws) => attachSttRelay(ws, { provider, finishTimeoutMs, onUtterance: (t) => utterances.push(t), ...(deaf ? { deaf } : {}), ...extra }));
  await new Promise<void>((r) => wss.once("listening", r));
  const { port } = wss.address() as { port: number };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`);
  sockets.push(ws);
  const received: SttServerMessage[] = [];
  ws.on("message", (d) => received.push(JSON.parse(String(d)) as SttServerMessage));
  await new Promise<void>((r) => ws.once("open", r));
  const waitFor = (pred: (m: SttServerMessage) => boolean, ms = 1000) =>
    new Promise<SttServerMessage>((resolve, reject) => {
      const hit = received.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error(`timeout waiting; got ${JSON.stringify(received)}`)), ms);
      ws.on("message", function h(d) {
        const m = JSON.parse(String(d)) as SttServerMessage;
        if (pred(m)) {
          clearTimeout(t);
          ws.off("message", h);
          resolve(m);
        }
      });
    });
  return { ws, received, utterances, waitFor };
}

const START = { type: "start", sampleRate: 16000, encoding: "pcm_s16le", channels: 1, lang: "en-US", keywords: ["Jev"] };

describe("STT relay", () => {
  it("starts the provider, forwards audio, and turns finals into utterances on stop", async () => {
    const provider = new FakeProvider();
    const { ws, received, utterances, waitFor } = await pair(provider);
    ws.send(JSON.stringify(START));
    await waitFor((m) => m.type === "ready");
    expect(received[0]).toEqual({ type: "ready", provider: "fake" });
    expect(provider.starts[0]).toMatchObject({ sampleRate: 16000, channels: 1, lang: "en-US", keywords: ["Jev"] });

    ws.send(new Uint8Array([1, 2, 3, 4]));
    await new Promise((r) => setTimeout(r, 30));
    expect(provider.audio.map((a) => Array.from(a))).toEqual([[1, 2, 3, 4]]);

    provider.emit!({ type: "transcript", text: "open wiki", final: false, speechFinal: false });
    await waitFor((m) => m.type === "transcript" && m.text === "open wiki");
    provider.emit!({ type: "transcript", text: "open wikipedia", final: true, speechFinal: false });
    // a single final is NOT dispatched on its own with true push-to-talk — only stop() flushes
    await new Promise((r) => setTimeout(r, 30));
    expect(received.some((m) => m.type === "utterance")).toBe(false);

    ws.send(JSON.stringify({ type: "stop" }));
    const utt = await waitFor((m) => m.type === "utterance");
    expect(utt).toEqual({ type: "utterance", text: "open wikipedia tail" });
    expect(utterances).toEqual(["open wikipedia tail"]);
    // the display is cleared after an utterance
    await waitFor((m) => m.type === "transcript" && m.text === "");
  });

  it("joins two finals separated by the provider's own internal pause-recycle into one utterance (M5.5 regression)", async () => {
    const provider = new FakeProvider();
    const { ws, waitFor, utterances } = await pair(provider);
    ws.send(JSON.stringify(START));
    await waitFor((m) => m.type === "ready");
    // the Apple helper emits final:true on its own ~700ms silence recycle mid-utterance —
    // both fragments must survive to the final joined utterance, not just the last one.
    provider.emit!({ type: "transcript", text: "open slack", final: true, speechFinal: false });
    provider.emit!({ type: "transcript", text: "and click general", final: true, speechFinal: false });
    ws.send(JSON.stringify({ type: "stop" }));
    await waitFor((m) => m.type === "utterance");
    expect(utterances).toEqual(["open slack and click general tail"]);
  });

  it("stop lets the provider flush its last final before closing", async () => {
    const provider = new FakeProvider();
    const { ws, waitFor, utterances } = await pair(provider);
    ws.send(JSON.stringify(START));
    await waitFor((m) => m.type === "ready");
    ws.send(JSON.stringify({ type: "stop" }));
    await waitFor((m) => m.type === "closed");
    expect(provider.finished).toBe(1);
    expect(utterances).toEqual(["tail"]);
  });

  it("flushes on a finish-timeout even if the provider never closes", async () => {
    class SlowProvider extends FakeProvider {
      override open(start: SttStart, onEvent: (ev: SttEvent) => void): SttStream {
        this.starts.push(start);
        queueMicrotask(() => onEvent({ type: "open" }));
        this.emit = onEvent;
        return { send: (a) => this.audio.push(a), finish: () => this.finished++, close: () => this.closed++ };
      }
    }
    const provider = new SlowProvider();
    const { ws, waitFor, utterances } = await pair(provider, 50);
    ws.send(JSON.stringify(START));
    await waitFor((m) => m.type === "ready");
    provider.emit!({ type: "transcript", text: "scroll down", final: true, speechFinal: false });
    ws.send(JSON.stringify({ type: "stop" }));
    await waitFor((m) => m.type === "closed");
    expect(utterances).toEqual(["scroll down"]);
  });

  it("rejects unsupported formats and closes the provider when the UI goes away", async () => {
    const provider = new FakeProvider();
    const { ws, waitFor } = await pair(provider);
    ws.send(JSON.stringify({ ...START, sampleRate: 96000 }));
    expect((await waitFor((m) => m.type === "error")).type).toBe("error");
    expect(provider.starts).toHaveLength(0);
    ws.send(JSON.stringify(START));
    await waitFor((m) => m.type === "ready");
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(provider.closed).toBe(1);
  });

  it("a second start replaces the first stream", async () => {
    const provider = new FakeProvider();
    const { ws, waitFor, received } = await pair(provider);
    ws.send(JSON.stringify(START));
    await waitFor((m) => m.type === "ready");
    const firstEmit = provider.emit!;
    ws.send(JSON.stringify(START));
    await new Promise((r) => setTimeout(r, 30));
    expect(provider.closed).toBe(1);
    expect(provider.starts).toHaveLength(2);
    firstEmit({ type: "transcript", text: "stale", final: true, speechFinal: false });
    ws.send(JSON.stringify({ type: "stop" }));
    await new Promise((r) => setTimeout(r, 60));
    expect(received.some((m) => m.type === "utterance" && m.text.includes("stale"))).toBe(false);
  });
});

describe("the relay while Jev is speaking", () => {
  it("drops the audio rather than transcribing her own voice", async () => {
    // Wake mode leaves the microphone open, so every reply is audible to it. Without this the
    // transcript of her own answer comes back as the next command and she answers herself.
    // Gated here, in-process, because a renderer round trip IS the window she would be heard in.
    const provider = new FakeProvider();
    let speaking = false;
    const { ws, waitFor } = await pair(provider, 200, () => speaking);
    ws.send(JSON.stringify(START));
    await waitFor((m) => m.type === "ready");

    ws.send(Buffer.from([1, 2]));
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.audio).toHaveLength(1);

    speaking = true;
    ws.send(Buffer.from([3, 4]));
    ws.send(Buffer.from([5, 6]));
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.audio).toHaveLength(1); // nothing extra reached the provider — and nothing billed

    speaking = false;
    ws.send(Buffer.from([7, 8]));
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.audio).toHaveLength(2);
  });

  it("discards a transcript that arrives from a recognition already in flight", async () => {
    // The frames stop the instant she speaks, but a recognition mid-flight can still deliver her
    // words a moment later — so the gate is checked on the way out as well as the way in.
    const provider = new FakeProvider();
    let speaking = false;
    const { ws, received, utterances, waitFor } = await pair(provider, 200, () => speaking);
    ws.send(JSON.stringify(START));
    await waitFor((m) => m.type === "ready");

    provider.emit!({ type: "transcript", text: "open slack", final: true, speechFinal: false });
    speaking = true;
    provider.emit!({ type: "transcript", text: "Slack's up", final: true, speechFinal: false });
    speaking = false;

    ws.send(JSON.stringify({ type: "stop" }));
    await waitFor((m) => m.type === "utterance");
    expect(utterances).toEqual(["open slack tail"]);
    expect(received.some((m) => m.type === "transcript" && m.text.includes("Slack's up"))).toBe(false);
  });

  it("is unchanged when no gate is configured", async () => {
    const provider = new FakeProvider();
    const { ws, waitFor } = await pair(provider);
    ws.send(JSON.stringify(START));
    await waitFor((m) => m.type === "ready");
    ws.send(Buffer.from([1, 2]));
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.audio).toHaveLength(1);
  });
});

describe("STT relay: wake mode", () => {
  it("refuses wake mode rather than billing a cloud engine to listen to an empty room", async () => {
    // No on-device listener configured (a non-Mac build, or the helper was never built). Falling
    // back to the accurate engine would leave a metered stream open on silence all day.
    const provider = new FakeProvider();
    const { ws, waitFor } = await pair(provider);
    ws.send(JSON.stringify({ ...START, mode: "wake" }));
    const err = (await waitFor((m) => m.type === "error")) as { message: string };
    expect(err.message).toMatch(/needs the on-device recogniser/);
    expect(provider.starts).toHaveLength(0);
  });

  it("opens only the listener, and says 'Yes?' itself when the name is heard alone", async () => {
    // The answer is spoken server-side on purpose: it has to pass through the same gate the
    // microphone is checked against, or Apple hears her say "Yes?" and she answers herself.
    const listener = new FakeProvider();
    const transcriber = new FakeProvider();
    let spoken = 0;
    const { ws, waitFor } = await pair(transcriber, 200, undefined, { listener, onWake: () => spoken++ });
    ws.send(JSON.stringify({ ...START, mode: "wake" }));
    await waitFor((m) => m.type === "ready");
    expect(transcriber.starts).toHaveLength(0);
    listener.emit?.({ type: "transcript", text: "hey jev", final: true, speechFinal: false });
    await waitFor((m) => m.type === "wake");
    expect(spoken).toBe(1);
    expect(transcriber.starts).toHaveLength(0); // still nothing billed just to answer
  });

  it("seeds the recogniser with the mishearings of the user's name", async () => {
    const listener = new FakeProvider();
    const { ws, waitFor } = await pair(new FakeProvider(), 200, undefined, { listener });
    ws.send(JSON.stringify({ ...START, mode: "wake" }));
    await waitFor((m) => m.type === "ready");
    // contextualStrings is already wired through to the native helper, so this costs nothing
    expect(listener.starts[0]?.keywords).toContain("Hey Jev");
    expect(listener.starts[0]?.keywords).toContain("Jev");
  });
});

describe("STT relay: switched off", () => {
  it("buffers nothing while paused, so a paused minute cannot be billed after resuming", async () => {
    // Two different silences, and folding them together was a bug: `deaf` (Jev is talking) keeps the
    // ring filling on purpose, so a command spoken over her survives. `paused` must not — otherwise
    // the first wake after a resume replays up to 8 seconds of a switched-off room to a metered
    // engine, which is the opposite of "nothing is heard, said or done".
    const listener = new FakeProvider();
    const transcriber = new FakeProvider();
    let paused = true;
    const { ws, waitFor } = await pair(transcriber, 200, undefined, { listener, paused: () => paused });
    ws.send(JSON.stringify({ ...START, mode: "wake" }));
    await waitFor((m) => m.type === "ready");

    for (let i = 0; i < 4; i++) ws.send(new Uint8Array(3200).fill(i + 1));
    await new Promise((r) => setTimeout(r, 120));
    expect(listener.audio).toHaveLength(0);

    paused = false; // switched back on
    ws.send(new Uint8Array(3200).fill(9));
    await new Promise((r) => setTimeout(r, 120));
    listener.emit?.({ type: "transcript", text: "hey jev open spotify", final: true, speechFinal: false });
    await new Promise((r) => setTimeout(r, 60));
    // only the one frame from after the resume reached the buffer, and so the billed engine
    const billed = transcriber.audio.reduce((n, c) => n + c.byteLength, 0);
    expect(billed).toBe(3200);
  });
});
