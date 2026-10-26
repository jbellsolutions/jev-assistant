#!/usr/bin/env node
/** Run one capability review.
 *
 *   node --import tsx scripts/review.mjs             # the real thing
 *   node --import tsx scripts/review.mjs --dry-run   # write the note, don't post or move the watermark
 *
 * Reads the repo's gitignored .env first, because launchd gives a job no shell and therefore none
 * of the keys this needs (OPENROUTER_API_KEY, BB_TOKEN, JEV_TOKEN, JEV_REVIEW_SLACK_WEBHOOK).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../server/env.ts";
import { runReview } from "../server/review/run.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFile(path.join(root, ".env"));

try {
  const r = await runReview({ dryRun: process.argv.includes("--dry-run") });
  console.log(`\n${r.fresh} new of ${r.harvested} · ${r.shortlisted} shortlisted · ${r.decided} decided · ${r.problems.length} problems`);
  console.log(r.note.uri);
} catch (err) {
  console.error(`review failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
