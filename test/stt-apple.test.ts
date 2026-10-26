import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AppleSpeechProvider } from "../server/stt/apple.js";
import type { SttEvent, SttStart } from "../server/stt/types.js";

const start: SttStart = { sampleRate: 16000, encoding: "pcm_s16le", channels: 1, lang: "en-US", keywords: ["Jev"] };

/** A fake jev-speech child: JSON lines in via `say`, PCM out via stdin. */
function fakeChild() {
  class Child extends EventEmitter {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    killed = false;
    kill(sig?: string) {
      this.killed = true;
      void sig;
      queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
      return true;
    }
  }
  const child = new Child();
  const say = (obj: unknown) => child.stdout.write(`${JSON.stringify(obj)}\n`);
  const received: Buffer[] = [];
  child.stdin.on("data", (d: Buffer) => received.push(d));
  return { child, say, received };
}

describe("AppleSpeechProvider", () => {
  it("spawns the helper with rate, locale and keywords; maps its lines to events", async () => {
    const fake = fakeChild();
    let spawned: { bin: string; args: string[] } | null = null;
    const provider = new AppleSpeechProvider({
      bin: "/x/jev-speech",
      spawn: ((bin: string, args: string[]) => {
        spawned = { bin, args };
        return fake.child;
      }) as never,
    });
    const events: SttEvent[] = [];
    const stream = provider.open(start, (e) => events.push(e));
    expect(spawned).toEqual({ bin: "/x/jev-speech", args: ["16000", "en-US", "Jev"] });
    fake.say({ type: "ready", onDevice: true });
    fake.say({ type: "transcript", text: "open wiki", final: false });
    fake.say({ type: "transcript", text: "Open Wikipedia.", final: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual([
      { type: "open" },
      { type: "transcript", text: "open wiki", final: false, speechFinal: false },
      // final:true is the helper's own ~700ms segment recycle, not the user's turn ending —
      // speechFinal stays false so the relay doesn't dispatch mid-dictation pauses as commands.
      { type: "transcript", text: "Open Wikipedia.", final: true, speechFinal: false },
    ]);
    stream.send(new Uint8Array([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.received.map((b) => Array.from(b))).toEqual([[1, 2, 3]]);
    stream.finish();
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.child.stdin.writableEnded).toBe(true);
    fake.child.emit("exit", 0, null);
    expect(events.at(-1)).toEqual({ type: "closed" });
  });

  it("reports a non-zero exit as an error, and close() kills the helper", async () => {
    const fake = fakeChild();
    const provider = new AppleSpeechProvider({ bin: "/x", spawn: (() => fake.child) as never });
    const events: SttEvent[] = [];
    const stream = provider.open(start, (e) => events.push(e));
    fake.child.stderr.write("boom");
    fake.child.emit("exit", 3, null);
    expect(events.map((e) => e.type)).toEqual(["error", "closed"]);
    expect(events[0]).toMatchObject({ message: expect.stringContaining("exited 3") });
    const fake2 = fakeChild();
    const p2 = new AppleSpeechProvider({ bin: "/x", spawn: (() => fake2.child) as never });
    const s2 = p2.open(start, () => {});
    s2.close();
    expect(fake2.child.killed).toBe(true);
    void stream;
  });
});
