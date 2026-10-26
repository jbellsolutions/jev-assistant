/** Jev's second voice: ElevenLabs, used when Fish has no key.
 *
 *  Why a second voice at all, when the first one works. the user's ELEVENLABS_API_KEY has been set the
 *  whole time — it is what powers speech-to-text today — so on the day the Fish key is missing,
 *  expired, or out of free quota, the difference between "Jev talks" and "Jev is mysteriously silent"
 *  is one fallback branch. Voice output was deleted once already (v4, commit 18cdbc2) and the thing
 *  that made it feel broken was silence with no explanation.
 *
 *  Deliberately a separate class rather than a refactor of FishSpeaker. The cache/stop/play shape is
 *  the same and is duplicated here on purpose: FishSpeaker is the working path the user actually hears,
 *  and reshaping it to host a fallback he may never reach is the wrong risk to take. Two vendors, two
 *  request shapes, no shared surface to break.
 *
 *  Voice `pNInz6obpgDQGcFmaJgB` is Adam — the same voice his Hermes already uses on Telegram, so Jev
 *  sounds like the assistant he knows rather than a second stranger. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Speaker } from "../../core/speak.js";
import { defaultCacheDir } from "./fish.js";
import { type Playback, type Player, selectPlayer } from "./player.js";

export const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
/** Adam — the voice his Hermes already speaks with on Telegram. */
export const DEFAULT_ELEVENLABS_VOICE_ID = "pNInz6obpgDQGcFmaJgB";
/** v4 Turbo (released 2026-09-28). Measured 2026-09-29 on the stream endpoint, one two-sentence line:
 *  first audio 0.27–0.48 s, whole line 1.0–1.3 s. `eleven_v4` is the higher-quality option (first
 *  audio 0.8–1.6 s). Either streams over plain HTTP, the same way Fish does. */
export const DEFAULT_ELEVENLABS_MODEL = "eleven_v4_turbo";
/** The v2-era settings. v4 ignores them (measured: byte-identical audio with and without), so they
 *  are sent only to the older models that use them. */
const V2_VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true };
export const usesVoiceSettings = (model: string): boolean => !/^eleven_v4/.test(model);
/** Same allowance as Fish: a real voice earns more words than `say` did. */
export const ELEVENLABS_MAX_CHARS = 600;
const REQUEST_TIMEOUT_MS = 30_000;

export interface ElevenLabsOptions {
  apiKey: string;
  voiceId?: string;
  model?: string;
  fetch?: typeof fetch;
  player?: Player;
  cacheDir?: string;
  onSynthesis?: (ms: number, chars: number) => void;
}

export class ElevenLabsSpeaker implements Speaker {
  readonly name = "elevenlabs";
  readonly maxChars = ELEVENLABS_MAX_CHARS;
  private readonly fetchImpl: typeof fetch;
  private readonly player: Player;
  private readonly cacheDir: string;
  private readonly voiceId: string;
  private readonly model: string;
  /** Warm one line at a time: the user's plan allows 2 requests at once, and live speech needs the other. */
  readonly warmConcurrency = 1;
  /** Sets, not slots — overlapping speech is ordinary (a timer fires mid-answer) and Escape has to
   *  mean quiet, all of it. Same reasoning as FishSpeaker. */
  private readonly inFlight = new Set<AbortController>();
  private readonly playing = new Set<{ stop(): void }>();

  constructor(private readonly opts: ElevenLabsOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.player = opts.player ?? selectPlayer();
    this.cacheDir = opts.cacheDir ?? defaultCacheDir();
    this.voiceId = opts.voiceId ?? DEFAULT_ELEVENLABS_VOICE_ID;
    this.model = opts.model ?? DEFAULT_ELEVENLABS_MODEL;
  }

  /** Keyed by vendor as well as voice and model: the cache dir is shared with Fish, and the same
   *  sentence in two different voices must not collide onto one file. */
  cachePath(text: string): string {
    const key = createHash("sha1").update(`elevenlabs|${this.voiceId}|${this.model}|${text}`).digest("hex");
    return path.join(this.cacheDir, `${key}.mp3`);
  }

  isCached(text: string): boolean {
    return existsSync(this.cachePath(text));
  }

  async render(text: string, signal?: AbortSignal): Promise<boolean> {
    if (this.isCached(text)) return false;
    const started = Date.now();
    const audio = await this.fetchAudio(text, signal, { track: false });
    if (!audio) return false;
    this.writeCache(text, audio);
    this.opts.onSynthesis?.(Date.now() - started, text.length);
    return true;
  }

  async prepare(text: string): Promise<void> {
    await this.render(text).catch(() => false);
  }

  async speak(text: string, signal?: AbortSignal): Promise<void> {
    const line = text.trim();
    if (!line) return;
    const file = this.cachePath(line);
    if (existsSync(file)) {
      await this.play(readFileSync(file), signal);
      return;
    }
    const started = Date.now();
    const audio = await this.streamAudio(line, signal);
    // Interrupted. `Speaker.speak` resolves when the line "has been spoken (or was interrupted)" —
    // callers reach this through `void speak(...)`, where a rejection is an unhandled rejection and
    // Node exits. A line cut off halfway is never cached.
    if (!audio) return;
    this.writeCache(line, audio);
    this.opts.onSynthesis?.(Date.now() - started, line.length);
  }

  /** Play while the audio is still arriving — the FishSpeaker.streamAudio pattern. Waiting for the
   *  whole file (what this did before v11.5) added the full synthesis time before the first word. */
  private async streamAudio(text: string, signal?: AbortSignal): Promise<Buffer | null> {
    const controller = new AbortController();
    this.inFlight.add(controller);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let playback: Playback | null = null;
    const parts: Buffer[] = [];
    try {
      const res = await this.request(text, controller.signal);
      if (!res.body) throw new Error("ElevenLabs returned no audio");
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || controller.signal.aborted) break;
        const buf = Buffer.from(value);
        if (!buf.length) continue;
        parts.push(buf);
        if (!playback) {
          // opened on the first byte, not before: a refused request must not leave ffplay waiting
          playback = this.player.open();
          this.playing.add(playback);
        }
        playback.write(buf);
      }
      if (controller.signal.aborted) return null;
      if (!parts.length) throw new Error("ElevenLabs returned no audio");
      clearTimeout(timer); // the download is done; the playback may run well past 30s
      playback!.end();
      await playback!.done;
      // stop() kills the player without aborting a finished download — still an interruption
      return controller.signal.aborted || !this.playing.has(playback!) ? null : Buffer.concat(parts);
    } catch (err) {
      if (controller.signal.aborted) return null;
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      this.inFlight.delete(controller);
      if (playback) {
        if (controller.signal.aborted) playback.stop();
        this.playing.delete(playback);
      }
    }
  }

  private async request(text: string, signal: AbortSignal): Promise<Response> {
    const res = await this.fetchImpl(`${ELEVENLABS_TTS_URL}/${this.voiceId}/stream?output_format=mp3_44100_64`, {
      method: "POST",
      // ElevenLabs authenticates with its own header, not a bearer token.
      headers: { "xi-api-key": this.opts.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: this.model, ...(usesVoiceSettings(this.model) ? { voice_settings: V2_VOICE_SETTINGS } : {}) }),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ElevenLabs refused to speak (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    return res;
  }

  stop(): void {
    for (const c of [...this.inFlight]) c.abort();
    this.inFlight.clear();
    for (const p of [...this.playing]) p.stop();
    this.playing.clear();
  }

  private async fetchAudio(text: string, signal?: AbortSignal, opts: { track?: boolean } = {}): Promise<Buffer | null> {
    const controller = new AbortController();
    const track = opts.track !== false;
    if (track) this.inFlight.add(controller);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.request(text, controller.signal);
      const audio = Buffer.from(await res.arrayBuffer());
      if (!audio.length) throw new Error("ElevenLabs returned no audio");
      return audio;
    } catch (err) {
      if (controller.signal.aborted) return null;
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (track) this.inFlight.delete(controller);
    }
  }

  private async play(audio: Buffer, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const playback = this.player.open();
    this.playing.add(playback);
    const onAbort = () => playback.stop();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      playback.write(audio);
      playback.end();
      await playback.done;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.playing.delete(playback);
    }
  }

  /** tmp + rename, so an interrupted write never leaves a truncated mp3 cached forever. */
  private writeCache(text: string, audio: Buffer): void {
    const file = this.cachePath(text);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, audio);
      renameSync(tmp, file);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to clean up */
      }
    }
  }
}
