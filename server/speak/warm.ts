/** Pre-render every scripted line before the user says anything.
 *
 *  This file is the actual answer to "it's moving slowly". A cold Fish call is a few hundred
 *  milliseconds; a cached line is an `afplay` of a local file. Since core/lines.ts is deliberately
 *  finite, the entire reply vocabulary can be synthesized once — at first launch, in the
 *  background — and from then on Jev answers out loud with no network in the path at all.
 *
 *  Three rules, all learned from the v4 failure rather than guessed:
 *   1. It never throws. A warm failure (no network on a plane, a rate limit, a bad key) must leave
 *      the app running exactly as it would with no voice; lines simply synthesize on first use.
 *   2. It never blocks startup. Callers fire and forget; the summary lands in the log when it lands.
 *   3. It stops early on an auth failure. 283 lines × "HTTP 401" is 283 pointless requests, and on
 *      a metered key a loop of retries is how a free tier becomes a bill. */
import { warmableLines } from "../../core/lines.js";
import type { FishSpeaker } from "./fish.js";

/** Gentle on the free tier and on a laptop's network; this is background work with nobody waiting. */
export const WARM_CONCURRENCY = 3;
/** Give up on the whole pass after this many consecutive failures — something is wrong, not flaky. */
export const WARM_GIVE_UP_AFTER = 3;
/** A 429 ("too many concurrent requests", a burst limit) is a wait, not a failure: retry the same
 *  line after these pauses. ElevenLabs caps the user's plan at 2 requests at once, and live speech
 *  can take a slot mid-warm. */
export const WARM_RETRY_MS = [1500, 4000, 10000];

export interface WarmReport {
  total: number;
  rendered: number;
  cached: number;
  failed: number;
  ms: number;
  /** The first failure's message, so the log says why rather than just a count. */
  problem: string | null;
}

/** True for a failure that will happen identically on every remaining line. */
function fatal(message: string): boolean {
  return /HTTP (401|402|403)\b|\bunauthor|\binvalid.{0,10}key|payment|quota/i.test(message);
}

function busy(message: string): boolean {
  return /HTTP 429\b/.test(message) && !fatal(message);
}

/** What warming needs from a voice: whether a line is already on disk, and how to put it there.
 *  Structural rather than `FishSpeaker`, so a second vendor warms with no change here. */
export interface WarmableSpeaker {
  isCached(text: string): boolean;
  render(text: string, signal?: AbortSignal): Promise<boolean>;
  /** How many lines this vendor may render at once; defaults to WARM_CONCURRENCY. */
  readonly warmConcurrency?: number;
}

export async function warmVoice(speaker: WarmableSpeaker, lines: string[] = warmableLines(), retryMs: number[] = WARM_RETRY_MS): Promise<WarmReport> {
  const started = Date.now();
  const report: WarmReport = { total: lines.length, rendered: 0, cached: 0, failed: 0, ms: 0, problem: null };

  // Cheap pass first: anything already on disk costs a stat, not a request.
  const missing = lines.filter((text) => {
    if (!speaker.isCached(text)) return true;
    report.cached++;
    return false;
  });

  let cursor = 0;
  let consecutive = 0;
  let stop = false;

  const worker = async (): Promise<void> => {
    while (!stop) {
      const index = cursor++;
      const text = missing[index];
      if (text === undefined) return;
      try {
        await renderWithWaits(speaker, text, retryMs);
        report.rendered++;
        consecutive = 0;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.failed++;
        report.problem ??= message;
        consecutive++;
        if (fatal(message) || consecutive >= WARM_GIVE_UP_AFTER) stop = true;
      }
    }
  };

  const width = Math.max(1, speaker.warmConcurrency ?? WARM_CONCURRENCY);
  await Promise.all(Array.from({ length: Math.min(width, Math.max(missing.length, 1)) }, worker));
  report.ms = Date.now() - started;
  return report;
}

async function renderWithWaits(speaker: WarmableSpeaker, text: string, retryMs: number[]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await speaker.render(text);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const wait = retryMs[attempt];
      if (!busy(message) || wait === undefined) throw err;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** One line for the startup log. */
export function describeWarm(r: WarmReport): string {
  if (r.failed && !r.rendered) return `voice cache: could not pre-render (${r.problem ?? "unknown"}) — lines will synthesize on first use`;
  const parts = [`${r.cached + r.rendered}/${r.total} lines ready`];
  if (r.rendered) parts.push(`${r.rendered} newly rendered in ${(r.ms / 1000).toFixed(1)}s`);
  if (r.failed) parts.push(`${r.failed} failed (${r.problem ?? "unknown"})`);
  return `voice cache: ${parts.join(", ")}`;
}
