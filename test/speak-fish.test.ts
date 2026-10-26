import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FISH_MODEL, FISH_TTS_URL, FishSpeaker } from "../server/speak/fish.js";
import { GatedSpeaker, SpeechGate } from "../server/speak/gate.js";
import type { Playback, Player } from "../server/speak/player.js";
import { ElevenLabsSpeaker } from "../server/speak/elevenlabs.js";
import { DEFAULT_VOICE_ID, chosenVoice, describeSpeaker, selectSpeaker } from "../server/speak/select.js";
import { WARM_CONCURRENCY, WARM_GIVE_UP_AFTER, describeWarm, warmVoice } from "../server/speak/warm.js";
import type { Speaker } from "../core/speak.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const freshCache = () => {
  const d = mkdtempSync(path.join(tmpdir(), "jev-tts-"));
  dirs.push(d);
  return d;
};

/** Records what it was fed; `done` settles on end/stop like the real players do. */
class FakePlayer implements Player {
  readonly name = "fake";
  playbacks: Array<{ writes: string[]; ended: boolean; stopped: boolean }> = [];
  open(): Playback {
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    const rec = { writes: [] as string[], ended: false, stopped: false };
    this.playbacks.push(rec);
    return {
      write: (chunk) => void rec.writes.push(Buffer.from(chunk).toString()),
      end: () => {
        rec.ended = true;
        finish();
      },
      stop: () => {
        rec.stopped = true;
        finish();
      },
      done,
    };
  }
}

interface Call {
  headers: Record<string, string>;
  body: { text: string; reference_id: string; format: string; model?: string };
}

/** Answers with `audio:<text>` as the bytes, and records exactly what was sent. */
function fakeFetch(calls: Call[], over: { status?: number; detail?: string; empty?: boolean } = {}) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(FISH_TTS_URL);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ headers, body: JSON.parse(String(init?.body)) as Call["body"] });
    if (over.status && over.status !== 200) return new Response(over.detail ?? "nope", { status: over.status });
    return new Response(over.empty ? new ArrayBuffer(0) : Buffer.from(`audio:${(JSON.parse(String(init?.body)) as Call["body"]).text}`));
  }) as unknown as typeof fetch;
}

const speaker = (calls: Call[], cacheDir: string, player: Player, over = {}) =>
  new FishSpeaker({ apiKey: "k", voiceId: "v1", fetch: fakeFetch(calls, over), player, cacheDir, ...over });

describe("the Fish request", () => {
  it("sends the model as a HEADER, never in the body", async () => {
    // hey-jev's siri.py:475 puts it in headers. In the body it is silently ignored and the
    // account's paid default model bills instead of the free one — a wrong-place bug that costs
    // money rather than failing.
    const calls: Call[] = [];
    await speaker(calls, freshCache(), new FakePlayer()).speak("Muted.");
    expect(calls[0]?.headers.model).toBe(DEFAULT_FISH_MODEL);
    expect(calls[0]?.headers.authorization).toBe("Bearer k");
    expect(calls[0]?.body).toEqual({ text: "Muted.", reference_id: "v1", format: "mp3" });
    expect(calls[0]?.body.model).toBeUndefined();
  });

  it("asks for mp3, which is what the player can stream", async () => {
    const calls: Call[] = [];
    await speaker(calls, freshCache(), new FakePlayer()).speak("Paused.");
    expect(calls[0]?.body.format).toBe("mp3");
  });

  it("reports the status and the API's own words when Fish refuses", async () => {
    const dir = freshCache();
    await expect(speaker([], dir, new FakePlayer(), { status: 402, detail: "insufficient credit" }).speak("hi")).rejects.toThrow(/HTTP 402.*insufficient credit/);
    // and nothing was cached, so the next attempt is a real retry rather than silence forever
    expect(readdirSync(dir)).toEqual([]);
  });

  it("treats an empty 200 as a failure, not as a silent line", async () => {
    await expect(speaker([], freshCache(), new FakePlayer(), { empty: true }).speak("hi")).rejects.toThrow(/no audio/);
  });

  it("says nothing at all for blank text, without calling out", async () => {
    const calls: Call[] = [];
    await speaker(calls, freshCache(), new FakePlayer()).speak("   ");
    expect(calls).toEqual([]);
  });
});

describe("the on-disk cache", () => {
  it("plays a repeated line from disk with no second request", async () => {
    // This is the whole answer to "it's moving slowly": the second "Muted." is a local file.
    const calls: Call[] = [];
    const player = new FakePlayer();
    const s = speaker(calls, freshCache(), player);
    await s.speak("Muted.");
    await s.speak("Muted.");
    expect(calls).toHaveLength(1);
    expect(player.playbacks.map((p) => p.writes.join(""))).toEqual(["audio:Muted.", "audio:Muted."]);
  });

  it("keys on the voice and the model, so a switch never replays the old voice", () => {
    const dir = freshCache();
    const a = new FishSpeaker({ apiKey: "k", voiceId: "v1", cacheDir: dir });
    const b = new FishSpeaker({ apiKey: "k", voiceId: "v2", cacheDir: dir });
    const c = new FishSpeaker({ apiKey: "k", voiceId: "v1", model: "other", cacheDir: dir });
    expect(a.cachePath("x")).not.toBe(b.cachePath("x"));
    expect(a.cachePath("x")).not.toBe(c.cachePath("x"));
    expect(a.cachePath("x")).toMatch(/[0-9a-f]{40}\.mp3$/);
  });

  it("leaves no partial file behind for a line that failed", async () => {
    const dir = freshCache();
    await speaker([], dir, new FakePlayer(), { status: 500 })
      .speak("x")
      .catch(() => {});
    expect(readdirSync(dir).filter((f) => !f.endsWith(".tmp"))).toEqual([]);
  });

  it("writes the audio it played, byte for byte", async () => {
    const dir = freshCache();
    const s = speaker([], dir, new FakePlayer());
    await s.speak("Locked.");
    expect(readFileSync(s.cachePath("Locked."), "utf8")).toBe("audio:Locked.");
    expect(s.isCached("Locked.")).toBe(true);
    expect(s.isCached("Not said.")).toBe(false);
  });
});

describe("interrupting", () => {
  /** Hangs until the signal aborts, then rejects — exactly what a real fetch does. */
  const hangingFetch = (started: { resolve: () => void }) =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
      started.resolve();
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })), { once: true });
      });
    }) as unknown as typeof fetch;

  it("RESOLVES when a cold line is cut off, rather than rejecting", async () => {
    // Speaker.speak promises to settle when the line "has been spoken (or was interrupted)". A
    // brain answer is never cached, so Escape mid-answer always takes this path — and callers
    // reach it as `void speak(...)`, where a rejection is an unhandled rejection that Node throws
    // on. A test whose fake fetch ignores the signal cannot see this at all.
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    const s = new FishSpeaker({ apiKey: "k", voiceId: "v", fetch: hangingFetch({ resolve: started }), player: new FakePlayer(), cacheDir: freshCache() });
    const speaking = s.speak("a long answer nobody wants to hear");
    await ready;
    s.stop();
    await expect(speaking).resolves.toBeUndefined();
  });

  it("resolves the same way when the caller aborts with its own signal", async () => {
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    const s = new FishSpeaker({ apiKey: "k", voiceId: "v", fetch: hangingFetch({ resolve: started }), player: new FakePlayer(), cacheDir: freshCache() });
    const controller = new AbortController();
    const speaking = s.speak("x", controller.signal);
    await ready;
    controller.abort();
    await expect(speaking).resolves.toBeUndefined();
  });

  it("caches nothing from an interrupted line, so the next try is a real retry", async () => {
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    const dir = freshCache();
    const s = new FishSpeaker({ apiKey: "k", voiceId: "v", fetch: hangingFetch({ resolve: started }), player: new FakePlayer(), cacheDir: dir });
    const speaking = s.speak("y");
    await ready;
    s.stop();
    await speaking;
    expect(readdirSync(dir)).toEqual([]);
    expect(s.isCached("y")).toBe(false);
  });

  it("stops a cached line's playback without a request at all", async () => {
    const calls: Call[] = [];
    const player = new FakePlayer();
    const s = speaker(calls, freshCache(), player);
    await s.speak("Muted.");
    const controller = new AbortController();
    controller.abort();
    await expect(s.speak("Muted.", controller.signal)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("does not let Escape kill a background warm render", async () => {
    // Warming runs concurrently at first launch. If render() claimed the interrupt slot, pressing
    // Escape during a cold reply would abort a warm request while the reply carried on playing.
    const calls: Call[] = [];
    const s = speaker(calls, freshCache(), new FakePlayer());
    const rendering = s.render("a warmed line");
    s.stop();
    await expect(rendering).resolves.toBe(true);
    expect(s.isCached("a warmed line")).toBe(true);
  });

  it("stop() is safe with nothing playing", () => {
    expect(() => speaker([], freshCache(), new FakePlayer()).stop()).not.toThrow();
  });
});

describe("pre-rendering at startup", () => {
  it("renders only what is missing and reports both counts", async () => {
    const calls: Call[] = [];
    const s = speaker(calls, freshCache(), new FakePlayer());
    await s.speak("Muted.");
    const r = await warmVoice(s, ["Muted.", "Paused.", "Locked."]);
    expect(r).toMatchObject({ total: 3, cached: 1, rendered: 2, failed: 0 });
    expect(calls).toHaveLength(3); // the one spoken + the two warmed
    expect(describeWarm(r)).toMatch(/3\/3 lines ready, 2 newly rendered/);
  });

  it("gives up immediately on a bad key instead of failing 283 times", async () => {
    // A loop of doomed requests against a metered API is how a free tier becomes a bill.
    const calls: Call[] = [];
    const r = await warmVoice(speaker(calls, freshCache(), new FakePlayer(), { status: 401, detail: "bad key" }), Array.from({ length: 50 }, (_, i) => `line ${i}`));
    expect(r.rendered).toBe(0);
    expect(calls.length).toBeLessThanOrEqual(WARM_GIVE_UP_AFTER);
    expect(r.problem).toMatch(/HTTP 401/);
    expect(describeWarm(r)).toMatch(/could not pre-render.*HTTP 401.*synthesize on first use/);
  });

  it("never throws, so a warm failure cannot stop the app starting", async () => {
    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const s = new FishSpeaker({ apiKey: "k", voiceId: "v", fetch: dead, player: new FakePlayer(), cacheDir: freshCache() });
    const r = await warmVoice(s, Array.from({ length: 40 }, (_, i) => `line ${i}`));
    expect(r.rendered).toBe(0);
    expect(r.problem).toMatch(/ECONNREFUSED/);
    // The brake is the consecutive-failure counter, and WARM_CONCURRENCY requests are already in
    // flight when it trips — so the bound is giveUp + concurrency - 1, not giveUp. What matters is
    // that it is a small constant and not all 40.
    expect(r.failed).toBeLessThanOrEqual(WARM_GIVE_UP_AFTER + WARM_CONCURRENCY - 1);
  });

  it("keeps to the vendor's own width, so ElevenLabs' 2-at-once plan limit leaves live speech a slot", async () => {
    let inFlight = 0;
    let most = 0;
    const s = {
      warmConcurrency: 1,
      isCached: () => false,
      render: async () => {
        most = Math.max(most, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return true;
      },
    };
    const r = await warmVoice(s, Array.from({ length: 6 }, (_, i) => `line ${i}`));
    expect(r.rendered).toBe(6);
    expect(most).toBe(1);
    expect(new ElevenLabsSpeaker({ apiKey: "k", player: new FakePlayer(), cacheDir: freshCache() }).warmConcurrency).toBe(1);
  });

  it("waits out a 429 and renders the same line, instead of counting it failed", async () => {
    // Live, 5 of 9 lines came back "HTTP 429 … maximum of 2 concurrent requests" and warm gave up.
    const tries = new Map<string, number>();
    const s = {
      isCached: () => false,
      render: async (text: string) => {
        const n = (tries.get(text) ?? 0) + 1;
        tries.set(text, n);
        if (n === 1) throw new Error('ElevenLabs refused to speak (HTTP 429): {"detail":{"code":"concurrent_limit_exceeded"}}');
        return true;
      },
    };
    const r = await warmVoice(s, ["a", "b", "c", "d"], [1, 1]);
    expect(r).toMatchObject({ rendered: 4, failed: 0 });
    expect([...tries.values()]).toEqual([2, 2, 2, 2]);
  });
});

describe("not hearing herself", () => {
  it("is deaf while audio plays and for a tail afterwards", () => {
    let now = 1_000;
    const gate = new SpeechGate(() => now, 300);
    expect(gate.deaf()).toBe(false);
    gate.begin();
    expect(gate.deaf()).toBe(true);
    expect(gate.speaking).toBe(true);
    gate.end();
    expect(gate.speaking).toBe(false);
    expect(gate.deaf()).toBe(true); // the room is still echoing
    now += 299;
    expect(gate.deaf()).toBe(true);
    now += 2;
    expect(gate.deaf()).toBe(false);
  });

  it("stays deaf while a second reply overlaps the first", () => {
    // A reply interrupted by a new one must not un-deafen the mic while audio is still coming out.
    let now = 0;
    const gate = new SpeechGate(() => now, 300);
    gate.begin();
    gate.begin();
    gate.end();
    now += 5_000;
    expect(gate.deaf()).toBe(true);
    gate.end();
    now += 5_000;
    expect(gate.deaf()).toBe(false);
  });

  it("closes the gate around every utterance, even one that throws", async () => {
    const gate = new SpeechGate();
    const boom: Speaker = {
      async speak() {
        expect(gate.deaf()).toBe(true);
        throw new Error("no voice");
      },
      stop() {},
      maxChars: 600,
    };
    const gated = new GatedSpeaker(boom, gate);
    expect(gated.maxChars).toBe(600);
    await expect(gated.speak("x")).rejects.toThrow("no voice");
    expect(gate.speaking).toBe(false);
  });
});

describe("choosing a voice", () => {
  it("is silent with no key at all, so a missing key is not a crash", () => {
    expect(selectSpeaker({})).toBeNull();
    expect(chosenVoice({})).toBe("off");
    expect(describeSpeaker(null, {})).toMatch(/off \(set FISH_AUDIO_API_KEY or ELEVENLABS_API_KEY/);
  });

  it("falls back to ElevenLabs when Fish has no key", () => {
    // the user's ELEVENLABS_API_KEY has been set the whole time (it powers speech-to-text), so the
    // difference between "Jev talks" and "Jev is mysteriously silent" is this one branch.
    const env = { ELEVENLABS_API_KEY: "el" };
    expect(chosenVoice(env)).toBe("elevenlabs");
    const s = selectSpeaker(env);
    expect(s).toBeInstanceOf(ElevenLabsSpeaker);
    expect(describeSpeaker(s, env)).toMatch(/voice out: elevenlabs \(eleven_v4_turbo/);
  });

  it("prefers Fish when both keys are present", () => {
    const env = { FISH_AUDIO_API_KEY: "f", ELEVENLABS_API_KEY: "el" };
    expect(chosenVoice(env)).toBe("fish");
    expect(selectSpeaker(env)).toBeInstanceOf(FishSpeaker);
  });

  it("lets JEV_TTS pin either voice, and stays silent if that one has no key", () => {
    expect(selectSpeaker({ FISH_AUDIO_API_KEY: "f", ELEVENLABS_API_KEY: "el", JEV_TTS: "elevenlabs" })).toBeInstanceOf(ElevenLabsSpeaker);
    expect(selectSpeaker({ FISH_AUDIO_API_KEY: "f", ELEVENLABS_API_KEY: "el", JEV_TTS: "fish" })).toBeInstanceOf(FishSpeaker);
    // asking for a voice whose key is missing is silence, not a silent downgrade to the other one
    expect(selectSpeaker({ ELEVENLABS_API_KEY: "el", JEV_TTS: "fish" })).toBeNull();
  });

  it("does not let two voices collide on one cache file", () => {
    // the cache dir is shared, so the same sentence in two voices must not overwrite each other
    const fish = selectSpeaker({ FISH_AUDIO_API_KEY: "f" }) as FishSpeaker;
    const el = selectSpeaker({ ELEVENLABS_API_KEY: "el" }) as ElevenLabsSpeaker;
    expect(fish.cachePath("Muted.")).not.toBe(el.cachePath("Muted."));
  });

  it("can be turned off even with a key present", () => {
    expect(selectSpeaker({ FISH_AUDIO_API_KEY: "k", JEV_TTS: "off" })).toBeNull();
    expect(describeSpeaker(null, { JEV_TTS: "off" })).toMatch(/JEV_TTS=off/);
  });

  it("uses hey-jev's voice by default and honours an override", () => {
    const s = selectSpeaker({ FISH_AUDIO_API_KEY: "k" }) as FishSpeaker;
    expect(s).toBeInstanceOf(FishSpeaker);
    const other = selectSpeaker({ FISH_AUDIO_API_KEY: "k", JEV_VOICE_ID: "zzz" }) as FishSpeaker;
    expect(s.cachePath("hi")).not.toBe(other.cachePath("hi"));
    expect(DEFAULT_VOICE_ID).toMatch(/^[0-9a-f]{32}$/);
    expect(describeSpeaker(s, { FISH_AUDIO_API_KEY: "k" })).toMatch(/voice out: fish \(s2\.1-pro-free/);
  });
});

describe("Fish: speaking while the audio is still arriving", () => {
  /** A response whose body sends `first`, then waits for `release()` before sending the rest. */
  function streamingFetch() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let requested!: () => void;
    const started = new Promise<void>((r) => (requested = r));
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(Buffer.from("first-"));
          requested();
          await Promise.race([gate, new Promise((r) => signal?.addEventListener("abort", r, { once: true }))]);
          if (signal?.aborted) return c.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
          c.enqueue(Buffer.from("rest"));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, release, started };
  }
  const flush = () => new Promise((r) => setTimeout(r, 5));

  it("plays the first bytes before the rest has arrived, then caches the whole line", async () => {
    const { fetchImpl, release, started } = streamingFetch();
    const player = new FakePlayer();
    const s = new FishSpeaker({ apiKey: "k", voiceId: "v", fetch: fetchImpl, player, cacheDir: freshCache() });
    const speaking = s.speak("a fresh answer");
    await started;
    await flush();
    expect(player.playbacks[0]?.writes).toEqual(["first-"]); // already playing
    release();
    await speaking;
    expect(player.playbacks[0]).toMatchObject({ writes: ["first-", "rest"], ended: true });
    expect(s.isCached("a fresh answer")).toBe(true);
  });

  it("stopped halfway: the sound stops and nothing half-said is cached", async () => {
    const { fetchImpl, started } = streamingFetch();
    const player = new FakePlayer();
    const dir = freshCache();
    const s = new FishSpeaker({ apiKey: "k", voiceId: "v", fetch: fetchImpl, player, cacheDir: dir });
    const speaking = s.speak("cut me off");
    await started;
    await flush();
    s.stop();
    await expect(speaking).resolves.toBeUndefined();
    expect(player.playbacks[0]?.stopped).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("ElevenLabs (v11.5): plays the first bytes before the rest arrive, and sends v4 its model and its own voice", async () => {
    const { fetchImpl, release, started } = streamingFetch();
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    const recording = (async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const player = new FakePlayer();
    const env = { ELEVENLABS_API_KEY: "el", ELEVENLABS_VOICE_ID: "adamVoice", JEV_VOICE_ID: "fishVoice" };
    const s = selectSpeaker(env, { fetch: recording, player }) as ElevenLabsSpeaker;
    Object.assign(s, { cacheDir: freshCache() });
    const speaking = s.speak("a fresh answer");
    await started;
    await flush();
    expect(player.playbacks[0]?.writes).toEqual(["first-"]); // already playing
    release();
    await speaking;
    expect(player.playbacks[0]).toMatchObject({ writes: ["first-", "rest"], ended: true });
    expect(sent[0]!.url).toContain("/text-to-speech/adamVoice/stream");
    expect(sent[0]!.body).toMatchObject({ model_id: "eleven_v4_turbo" });
    expect(sent[0]!.body.voice_settings).toBeUndefined(); // v4 ignores them
  });

  it("ElevenLabs: the quality model by name, and the v2 settings only for v2 models", () => {
    expect(describeSpeaker(selectSpeaker({ ELEVENLABS_API_KEY: "el", ELEVENLABS_TTS_MODEL: "eleven_v4" }), { ELEVENLABS_API_KEY: "el", ELEVENLABS_TTS_MODEL: "eleven_v4" })).toMatch(/eleven_v4,/);
    // an eleven_ model in the shared variable picks ElevenLabs' model and never reaches Fish
    const fish = selectSpeaker({ FISH_AUDIO_API_KEY: "f", JEV_TTS_MODEL: "eleven_v4" }) as FishSpeaker;
    expect(fish.cachePath("x")).toBe(new FishSpeaker({ apiKey: "f", voiceId: DEFAULT_VOICE_ID, model: DEFAULT_FISH_MODEL, cacheDir: path.dirname(fish.cachePath("x")) }).cachePath("x"));
  });

  it("a refused request never opens the player", async () => {
    const player = new FakePlayer();
    const s = new FishSpeaker({ apiKey: "k", voiceId: "v", fetch: fakeFetch([], { status: 402, detail: "no credit" }), player, cacheDir: freshCache() });
    await expect(s.speak("hello there")).rejects.toThrow(/HTTP 402/);
    expect(player.playbacks).toEqual([]);
  });
});
