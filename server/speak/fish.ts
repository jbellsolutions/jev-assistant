/** Jev's voice: Fish Audio, with every line it has said before served from disk.
 *
 *  Why this exists at all. Voice output was deleted in v4 (commit 18cdbc2) on the user's verdict —
 *  "the audio sucks and it's very robotic… it's moving slowly". Both halves of that are addressed
 *  here rather than hoped away: a real voice model instead of macOS `say`, and an on-disk cache
 *  keyed by the exact text, so the second time Jev says "Muted." there is no network at all. The
 *  scripted table in core/lines.ts is finite precisely so server/speak/warm.ts can render all of
 *  it before the user ever speaks, which is what turns "moving slowly" into instant.
 *
 *  Two details taken verbatim from hey-jev, both of which cost money to get wrong:
 *   - `model` travels as an HTTP HEADER, not a body field. In the body it is ignored and the
 *     account's paid default model bills instead of the free `s2.1-pro-free`.
 *   - the cache key includes the voice, so changing JEV_VOICE_ID does not serve the old voice.
 *  The key also includes the model, which hey-jev's does not: switching models should not replay
 *  audio from the previous one.
 *
 *  Format is mp3, matching server/speak/player.ts's `ffplay -f mp3` and the files already sitting
 *  in ~/.jev/tts-cache from the deleted layer. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Speaker } from "../../core/speak.js";
import { type Playback, type Player, selectPlayer } from "./player.js";

export const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
/** Free through the end of November 2026, then $15/M characters — which the cache keeps at cents. */
export const DEFAULT_FISH_MODEL = "s2.1-pro-free";
/** A real voice earns more words than `say` did (MAX_SPOKEN, 160). */
export const FISH_MAX_CHARS = 600;
const REQUEST_TIMEOUT_MS = 30_000;

export const defaultCacheDir = () => path.join(process.env.JEV_HOME ?? path.join(homedir(), ".jev"), "tts-cache");

export interface FishOptions {
  apiKey: string;
  voiceId: string;
  model?: string;
  fetch?: typeof fetch;
  player?: Player;
  cacheDir?: string;
  /** Called once per synthesis with how long it took, for the startup log. */
  onSynthesis?: (ms: number, chars: number) => void;
}

export class FishSpeaker implements Speaker {
  readonly name = "fish";
  readonly maxChars = FISH_MAX_CHARS;
  private readonly fetchImpl: typeof fetch;
  private readonly player: Player;
  private readonly cacheDir: string;
  private readonly model: string;
  /** Sets, not single slots. M5 made overlapping speech ordinary — a timer alert fires while a brain
   *  answer is still being read — and with one slot each the newer line evicted the older one, so
   *  `stop()` silenced only the newest while the first kept playing and the microphone stayed deaf
   *  behind it. Escape has to mean quiet, all of it. */
  private readonly inFlight = new Set<AbortController>();
  private readonly playing = new Set<{ stop(): void }>();

  constructor(private readonly opts: FishOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.player = opts.player ?? selectPlayer();
    this.cacheDir = opts.cacheDir ?? defaultCacheDir();
    this.model = opts.model ?? DEFAULT_FISH_MODEL;
  }

  /** Where this exact line, in this voice, on this model, lives on disk. */
  cachePath(text: string): string {
    const key = createHash("sha1").update(`${this.opts.voiceId}|${this.model}|${text}`).digest("hex");
    return path.join(this.cacheDir, `${key}.mp3`);
  }

  isCached(text: string): boolean {
    return existsSync(this.cachePath(text));
  }

  /** Synthesize and cache without playing — the warm pass. Returns false when already cached.
   *
   *  Deliberately does NOT register with `inFlight`: warming runs concurrently at startup, and if
   *  it claimed that slot then pressing Escape during a cold reply would abort a background warm
   *  request while the reply kept playing. `stop()` is for the thing the user is listening to. */
  async render(text: string, signal?: AbortSignal): Promise<boolean> {
    if (this.isCached(text)) return false;
    const started = Date.now();
    const audio = await this.fetchAudio(text, signal, { track: false });
    if (!audio) return false; // aborted
    this.writeCache(text, audio);
    this.opts.onSynthesis?.(Date.now() - started, text.length);
    return true;
  }

  /** Render ahead of time and never throw: a line that could not be pre-rendered simply pays
   *  synthesis when it is actually needed, which is the behaviour without this method at all. */
  async prepare(text: string): Promise<void> {
    await this.render(text).catch(() => false);
  }

  async speak(text: string, signal?: AbortSignal): Promise<void> {
    const line = text.trim();
    if (!line) return;
    const file = this.cachePath(line);

    // The common path: this line has been said before (or was pre-rendered at startup), so it is a
    // local file play and starts immediately.
    if (existsSync(file)) {
      await this.play(readFileSync(file), signal);
      return;
    }

    const started = Date.now();
    const audio = await this.streamAudio(line, signal);
    // Interrupted. `Speaker.speak` promises to resolve when the line "has been spoken (or was
    // interrupted)", so this is a normal return, not a failure: a brain answer is never cached, so
    // Escape mid-answer takes exactly this path, and callers reach it through `void speak(...)` —
    // a rejection here is an unhandled rejection, which Node throws on.
    if (!audio) return;
    this.writeCache(line, audio);
    this.opts.onSynthesis?.(Date.now() - started, line.length);
  }

  /** Play a line while it is still being synthesized. Fish sends the MP3 chunked: measured
   *  2026-09-26, the first bytes arrive ~0.5s after the request and the last ~3.2–3.6s after, for
   *  a two-sentence reply. Waiting for all of it (what this did before v11.4) put ~3s of silence
   *  between the brain's answer and the first word. ffplay plays from stdin as bytes come in.
   *
   *  Resolves with the whole MP3 once played (for the cache), or null when interrupted — a line cut
   *  off halfway is never cached, or it would be replayed truncated forever. */
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
      if (!res.body) throw new Error("Fish Audio returned no audio");
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
      if (!parts.length) throw new Error("Fish Audio returned no audio");
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

  stop(): void {
    for (const c of [...this.inFlight]) c.abort();
    this.inFlight.clear();
    for (const p of [...this.playing]) p.stop();
    this.playing.clear();
  }

  /** Returns null when the request was interrupted — see the note in `speak`. Any other failure
   *  still throws, because a bad key or an empty response is worth surfacing. */
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
      if (!audio.length) throw new Error("Fish Audio returned no audio");
      return audio;
    } catch (err) {
      // An abort is how interruption is spelled; a timeout aborts too, and the caller cannot tell
      // the difference from here — but in both cases the right answer is "nothing was said", not a
      // thrown error, because nobody is waiting on this promise to handle it.
      if (controller.signal.aborted) return null;
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (track) this.inFlight.delete(controller);
    }
  }

  /** The one TTS request; throws on a refusal, with Fish's own reason. */
  private async request(text: string, signal: AbortSignal): Promise<Response> {
    const res = await this.fetchImpl(FISH_TTS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        // NOT a body field. See the header note at the top of this file.
        model: this.model,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text, reference_id: this.opts.voiceId, format: "mp3" }),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Fish Audio refused to speak (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    return res;
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

  /** tmp + rename, so an interrupted write never leaves a truncated mp3 to be played forever. */
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
