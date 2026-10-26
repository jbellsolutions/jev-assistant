/** One twice-weekly review, end to end.
 *
 *  Order matters and is the whole design:
 *    manifest → harvest → Scout → Jev reads the shortlist → Surveyor → Arbiter → note → Slack → watermark
 *
 *  The watermark moves LAST, and only after the note is on disk. A run that dies in the middle must
 *  leave those items unreviewed so the next run picks them up; marking them early loses them for
 *  good, and nothing would ever say so. */
import { DEFAULT_ONESHOT_MODEL, OneShot } from "../brain/oneshot.js";
import { selectBrowserBox } from "../browserbox.js";
import { createArbiter } from "./arbiter.js";
import { deliberate } from "./deliberate.js";
import { investigate } from "./investigate.js";
import { buildManifest, tokenFromEnvFile } from "./manifest.js";
import { type WrittenNote, postSlack, renderSlack, writeNote } from "./publish.js";
import { type ReadTabOptions, harvest } from "./sheet.js";
import { readReviewState, recordReviewed } from "./state.js";

export const REVIEW_MODEL_TIMEOUT_MS = 4 * 60_000;

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  vault?: string;
  statePath?: string;
  sheet?: ReadTabOptions;
  date?: Date;
  /** Do everything except move the watermark and post to Slack. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface RunReport {
  note: WrittenNote;
  slack: string;
  harvested: number;
  fresh: number;
  /** Fresh rows the pipeline never ranked, so the Scout never saw them. */
  notScouted: number;
  shortlisted: number;
  decided: number;
  problems: string[];
}

export async function runReview(opts: RunOptions = {}): Promise<RunReport> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((l: string) => console.log(l));
  const date = opts.date ?? new Date();

  // The panel's 60s default is right for a user watching a task row; it is too tight here, where
  // the Surveyor's prompt carries the whole capability manifest. Two live runs lost items to that
  // timeout. A scheduled job has nobody waiting, so it can afford to ask properly.
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("no model is configured for the review — set OPENROUTER_API_KEY in .env");
  const oneshot = new OneShot({ apiKey, model: env.JEV_TASK_MODEL?.trim() || env.JEV_BRAIN_MODEL?.trim() || DEFAULT_ONESHOT_MODEL, timeoutMs: REVIEW_MODEL_TIMEOUT_MS });
  // The Arbiter is the same model on OpenRouter — no Hermes, so a Monday run does not depend on a
  // second agent's gateway being up.
  const arbiter = createArbiter(env, { timeoutMs: REVIEW_MODEL_TIMEOUT_MS });
  if (!arbiter) throw new Error("no model is configured for the review's Arbiter — set OPENROUTER_API_KEY in .env");

  log("reading Jev's own capabilities from source…");
  const token = tokenFromEnvFile();
  const manifest = await buildManifest({ token });
  log(`  ${manifest.executors.length} surfaces, ${manifest.actions.length} fast-lane actions, ${manifest.brainTools.length} brain tools, ${manifest.connectors.reads.length + manifest.connectors.writes.length} connector actions${manifest.planned.length ? `, declared-only: ${manifest.planned.join(", ")}` : ""}`);

  // No auth preflight here any more. The Sheet is read over plain HTTPS first (see readTabPublic),
  // so a normal run never touches a credential store at all; when that route is gone and gws has to
  // be used, readTab asks `gws auth status` itself and names the remedy in the error it throws. A
  // preflight here would have made every run announce a gws problem it no longer depends on.
  log("reading the watch Sheet…");
  const state = readReviewState(opts.statePath);
  const found = await harvest(state, { log, ...(opts.sheet ?? {}) }, date);
  log(`  ${found.all.length} rows, ${found.fresh.length} new since the last review — ${found.eligible.length} ranked by the pipeline, ${found.unranked.length} it never ranked (not scouted), ${found.notYetRanked.length} it has not reached yet (held for next time)`);
  if (found.staleWarning) log(`  ! ${found.staleWarning}`);

  log("deliberating…");
  const result = await deliberate(found.eligible, found.ranked, {
    oneshot,
    arbiter,
    manifest,
    log,
    investigate: (shortlist) => {
      log(`  Jev's own browser is reading ${shortlist.length} pages…`);
      return investigate(shortlist, { box: selectBrowserBox(env), oneshot });
    },
  });
  log(`  ${result.shortlist.length} shortlisted, ${result.decisions.length} decided`);
  for (const p of result.problems) log(`  ! ${p}`);

  const input = { result, harvest: found, manifest, findings: result.findings, investigationNote: result.investigationNote, date };
  const note = writeNote(input, opts.vault);
  log(`wrote ${note.file}`);

  const slack = opts.dryRun ? "slack: skipped (dry run)" : await postSlack(renderSlack(input, note), env.JEV_REVIEW_SLACK_WEBHOOK);
  log(slack);

  // Last, and only now: these items have been seen by a human-readable record.
  // The unranked rows were screened by policy, not lost — a decision was made about each one, so the
  // watermark may pass them. Only rows that were eligible and got no answer hold it back.
  // Two lists, and the split is load-bearing. `unranked` rows sit at or before the ranker's horizon,
  // so the pipeline looked at them and passed — a decision, and the watermark may pass them too.
  // `notYetRanked` rows are newer than anything ranked: skipping them was timing, not a decision, so
  // they hold the cutoff back and come round again once the ranker catches up.
  if (!opts.dryRun) recordReviewed([...result.considered, ...found.unranked], [...result.unconsidered, ...found.notYetRanked], found.newestSeenAt, opts.statePath, () => date);

  return { note, slack, harvested: found.all.length, fresh: found.fresh.length, notScouted: found.unranked.length, shortlisted: result.shortlist.length, decided: result.decisions.length, problems: result.problems };
}
