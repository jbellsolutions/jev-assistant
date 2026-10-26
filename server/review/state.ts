/** The review's own watermark (`~/.jev/review/state.json`, mode 0600).
 *
 *  It cannot borrow the watch pipeline's `seen` column: `mark_seen.py` runs *daily* and consumes
 *  `seen` for the daily digest, so by Monday morning everything from the weekend is already
 *  marked. A twice-weekly review needs to remember what *it* has looked at.
 *
 *  Two properties this file exists to guarantee, both of which a naive "remember the ids I saw"
 *  design gets wrong:
 *
 *  1. NOTHING IS MARKED REVIEWED THAT WAS NOT ACTUALLY CONSIDERED. A row lost to a failed Scout
 *     batch, or cut by the shortlist cap, must come back next time. Only the caller knows which
 *     rows were genuinely looked at, so it passes them in — this file never infers.
 *  2. MEMBERSHIP IS BOUNDED BY DATE, NOT BY COUNT. `all-items` is the pipeline's entire database,
 *     so a count-capped id list starts forgetting its oldest entries while those rows are still in
 *     the Sheet — and they silently resurface as "new" on every run forever after. Entries are
 *     pruned by age instead, and the date cutoff does the real filtering.
 *
 *  Same atomic tmp+rename discipline as server/state.ts. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ReviewState {
  /** ISO timestamp of the last run that got all the way to a written note. */
  lastRunAt?: string;
  /** Rows first seen at or before this have already been through a review. */
  cutoff?: string;
  /** Newest date seen in the Sheet — how the staleness guard notices a dead pipeline. */
  newestSeenAt?: string;
  /** url → the date the pipeline first saw it, for rows this review has considered. */
  reviewed?: Record<string, string>;
}

/** A row can be written to the Sheet slightly after the moment it records, and clocks differ, so
 *  the cutoff is pulled back a little and the id map catches anything that comes round twice. */
export const OVERLAP_HOURS = 12;
/** How far back the very first run looks. Without this it would scout the pipeline's whole history. */
export const FIRST_RUN_DAYS = 7;
/** Reviewed entries older than the cutoff by this much can never match a fresh row again. */
export const RETAIN_DAYS = 45;

export const reviewDir = () => path.join(process.env.JEV_HOME ?? path.join(homedir(), ".jev"), "review");
export const defaultReviewStatePath = () => path.join(reviewDir(), "state.json");

export function readReviewState(file = defaultReviewStatePath()): ReviewState {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ReviewState) : {};
  } catch {
    return {};
  }
}

export function writeReviewState(patch: Partial<ReviewState>, file = defaultReviewStatePath()): ReviewState {
  const next: ReviewState = { ...readReviewState(file), ...patch };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return next;
}

export const parseWhen = (s: string | undefined): number => {
  if (!s) return 0;
  // the pipeline truncates to 19 chars, giving either "2026-09-24T13:00:00" or "2026-09-24 13:00:00"
  const t = Date.parse(s.trim().replace(" ", "T"));
  return Number.isNaN(t) ? 0 : t;
};

/** Rows first seen after this instant are candidates for review. */
export function cutoffMs(state: ReviewState, now: Date): number {
  const stored = parseWhen(state.cutoff);
  if (stored) return stored - OVERLAP_HOURS * 3_600_000;
  return now.getTime() - FIRST_RUN_DAYS * 86_400_000;
}

/** Fold a finished run into the watermark.
 *
 *  `considered` is exactly the rows that were put in front of an agent and got an answer — never
 *  the whole harvest. Called ONLY after the note is on disk: a run that dies mid-deliberation must
 *  leave its rows unreviewed so the next run picks them up. */
export function recordReviewed(
  considered: Array<{ key: string; seenAt: string }>,
  /** Eligible rows this run did NOT answer on: cap overflow and failed Scout batches. The cutoff is
   *  held below the oldest of them, because rows are considered out of date order — a later batch
   *  succeeding would otherwise carry the cutoff past an earlier batch that threw. */
  unconsidered: Array<{ key: string; seenAt: string }>,
  newestSeenAt: string | null,
  file = defaultReviewStatePath(),
  now = () => new Date(),
): ReviewState {
  const at = now();
  const prev = readReviewState(file);
  const reviewed = { ...(prev.reviewed ?? {}) };
  for (const c of considered) if (c.key) reviewed[c.key] = c.seenAt;

  // The cutoff only moves forward as far as rows actually considered, so a capped or partly
  // failed run cannot step over the rows it skipped.
  const consideredNewest = considered.reduce((best, c) => Math.max(best, parseWhen(c.seenAt)), 0);
  const oldestSkipped = unconsidered.reduce((min, c) => {
    const t = parseWhen(c.seenAt);
    return t && (min === 0 || t < min) ? t : min;
  }, 0);
  const bounded = oldestSkipped ? Math.min(consideredNewest, oldestSkipped - 1) : consideredNewest;
  const cutoff = consideredNewest ? new Date(Math.max(bounded, parseWhen(prev.cutoff))).toISOString() : prev.cutoff;

  const floor = parseWhen(cutoff) - (OVERLAP_HOURS * 3_600_000 + RETAIN_DAYS * 86_400_000);
  for (const [k, v] of Object.entries(reviewed)) if (parseWhen(v) && parseWhen(v) < floor) delete reviewed[k];

  return writeReviewState({ lastRunAt: at.toISOString(), reviewed, ...(cutoff ? { cutoff } : {}), ...(newestSeenAt ? { newestSeenAt } : {}) }, file);
}
