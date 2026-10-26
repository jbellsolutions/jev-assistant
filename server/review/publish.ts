/** Where a review ends up: a note in the Obsidian vault, then a nudge in Slack.
 *
 *  The vault is the record and Slack is the notification — that ordering is deliberate and is
 *  the user's standing rule: memory IS Obsidian, linked notes, openable with obsidian://. A review
 *  that only ever posted to Slack would scroll away by Wednesday.
 *
 *  Two things the note must never do, both learned the hard way on this project:
 *   - summarise the disagreement away. The round where the Scout defends a claim the Arbiter
 *     doubted is the most useful paragraph in the document; it is reproduced in full.
 *   - read as complete when it isn't. Every problem, every unread page and a stale upstream
 *     pipeline all appear above the decisions, not in a footnote. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Decision, DeliberationResult } from "./deliberate.js";
import type { Finding } from "./investigate.js";
import type { Manifest } from "./manifest.js";
import type { Harvest } from "./sheet.js";

export const VAULT = process.env.JEV_VAULT ?? path.join(process.env.HOME || "", "Documents", "Jev");
export const REVIEW_FOLDER = "Jev/Reviews";
export const INDEX_NOTE = "Jev Capability Index";

const ymd = (d: Date) => d.toISOString().slice(0, 10);
/** Obsidian link targets cannot contain these, and a broken [[link]] is a dead end in the graph. */
const linkSafe = (s: string) => s.replace(/[[\]#|^\\/:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

export interface PublishInput {
  result: DeliberationResult;
  harvest: Harvest;
  manifest: Manifest;
  findings: Finding[];
  /** Anything the investigation pass wants said out loud (Jev wasn't running, a run stalled). */
  investigationNote: string | null;
  date?: Date;
}

const RANK: Record<Decision["decision"], number> = { adopt: 0, pilot: 1, watch: 2, reject: 3 };

export function renderNote(input: PublishInput): string {
  const { result, harvest, manifest, findings } = input;
  const date = input.date ?? new Date();
  const byId = new Map(result.shortlist.map((c) => [c.item.key, c]));
  const decisions = [...result.decisions].sort((a, b) => RANK[a.decision] - RANK[b.decision] || a.id.localeCompare(b.id));
  const adopted = decisions.filter((d) => d.decision === "adopt" || d.decision === "pilot");
  const unread = findings.filter((f) => f.status === "not-investigated").length;

  const warnings = [
    harvest.staleWarning,
    input.investigationNote,
    unread ? `${unread} of ${findings.length} shortlisted pages were not opened and read, so those were judged from the Sheet alone.` : null,
    ...result.problems,
  ].filter(Boolean) as string[];

  const out: string[] = [];
  out.push("---");
  out.push(`date: ${ymd(date)}`);
  out.push(`itemsHarvested: ${harvest.all.length}`);
  out.push(`itemsNew: ${harvest.fresh.length}`);
  out.push(`itemsScouted: ${harvest.eligible.length}`);
  out.push(`itemsNotScouted: ${harvest.unranked.length}`);
  out.push(`itemsHeldForNextRun: ${harvest.notYetRanked.length}`);
  out.push(`rankerHorizon: ${harvest.rankedHorizon ?? "unknown"}`);
  out.push(`shortlisted: ${result.shortlist.length}`);
  out.push(`adopted: ${adopted.length}`);
  out.push(`pipelineNewestSeen: ${harvest.newestSeenAt ?? "unknown"}`);
  out.push(`complete: ${warnings.length === 0}`);
  out.push("tags: [jev, capability-review]");
  out.push("---");
  out.push("");
  out.push(`# Jev capability review — ${ymd(date)}`);
  out.push("");
  out.push(`${harvest.fresh.length} new items since the last review, out of ${harvest.all.length} in the watch database. ${result.shortlist.length} shortlisted, ${adopted.length} worth doing.`);
  // Said out loud, because a count that only appears as a smaller number is not a disclosure. The
  // review reads what the pipeline ranked; everything else is skipped ON PURPOSE and should look
  // like a choice rather than like nothing happened.
  if (harvest.unranked.length) {
    out.push(`${harvest.unranked.length} of those were not scouted: the watch pipeline's own ranker looked at them and did not rank them, and this review takes its intake from \`ranked-items\`. They are not held for next time — skipping them was the decision.`);
  }
  if (harvest.notYetRanked.length) {
    out.push(`${harvest.notYetRanked.length} more are newer than anything the ranker has reached (its horizon is ${harvest.rankedHorizon ?? "unknown"}), so they are **held for the next review** rather than skipped — nothing has decided about them yet.`);
  }
  out.push("");

  if (warnings.length) {
    out.push("## What this review could not see");
    out.push("");
    for (const w of warnings) out.push(`- ${w}`);
    out.push("");
  }

  out.push("## Decisions");
  out.push("");
  if (decisions.length === 0) {
    out.push("_Nothing was shortlisted this time._");
    out.push("");
  } else {
    out.push("| | Decision | Value | Effort | Risk | Item | Why |");
    out.push("|---|---|---|---|---|---|---|");
    for (const d of decisions) {
      const c = byId.get(d.id);
      const title = c ? `[${c.item.title}](${c.item.url})` : d.id;
      out.push(`| ${d.byRule ? "⚖️" : ""} | **${d.decision}** | ${d.value} | ${d.effort} | ${d.risk} | ${title} | ${d.why.replace(/\|/g, "\\|").replace(/\n+/g, " ")} |`);
    }
    out.push("");
    if (decisions.some((d) => d.byRule)) {
      out.push("⚖️ = decided by a standing rule in code, not by the Arbiter's judgement.");
      out.push("");
    }
  }

  const dissent = decisions.filter((d) => d.rebuttal);
  if (dissent.length) {
    out.push("## Where they disagreed");
    out.push("");
    out.push("_The Arbiter challenged these; the Scout answered. This is the part worth reading._");
    out.push("");
    for (const d of dissent) {
      const c = byId.get(d.id);
      out.push(`### ${c?.item.title ?? d.id}`);
      out.push("");
      out.push(`- **Scout (${d.rebuttal!.stance}):** ${d.rebuttal!.argument}`);
      out.push(`- **Arbiter's final call:** ${d.decision} — ${d.why}`);
      out.push("");
    }
  }

  if (adopted.length) {
    out.push("## What to do next");
    out.push("");
    for (const d of adopted) {
      const c = byId.get(d.id);
      if (!c) continue;
      out.push(`- [[${linkSafe(c.item.title)}]] — ${d.decision}. ${c.survey ? `We are at "${c.survey.verdict}" (nearest: \`${c.survey.nearest}\`); it would add: ${c.survey.gap}` : "The Surveyor could not place it."}`);
    }
    out.push("");
  }

  out.push("## What Jev had at the time");
  out.push("");
  out.push(`Generated from source at \`${manifest.repo}\`.`);
  out.push("");
  out.push(`- Surfaces: ${manifest.executors.map((e) => `\`${e.id}\``).join(", ")}${manifest.planned.length ? `; declared with nothing behind them: ${manifest.planned.map((p) => `\`${p}\``).join(", ")}` : ""}`);
  out.push(`- Fast-lane actions: ${manifest.actions.length}; lanes: ${manifest.routes.map((r) => r.id).join(", ")}`);
  out.push(`- Brain (${manifest.brainModel}): ${manifest.brainTools.map((t) => `\`${t}\``).join(", ")}`);
  out.push(`- Connectors: ${manifest.connectors.reads.length} reads, ${manifest.connectors.writes.length} writes (ask first); browser-box: ${manifest.browserBox.join(", ")}`);
  out.push(manifest.live ? `- Live when this ran: ${manifest.live.problem ?? (manifest.live.sessions.map((s) => s.id).join(", ") || "nothing attached")}` : `- The Jev companion was not running when this was generated.`);
  out.push("");
  out.push(`See [[${INDEX_NOTE}]] for how this has changed over time.`);
  out.push("");
  return out.join("\n");
}

function writeAtomic(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

export interface WrittenNote {
  file: string;
  /** What to paste into a browser to open it in Obsidian. */
  uri: string;
  itemNotes: string[];
}

/** One note per adopted item, so the graph accumulates something to link back to. Never overwrite
 *  an existing one — a later review may have added notes of the user's own to it. */
export function writeNote(input: PublishInput, vault = VAULT): WrittenNote {
  const date = input.date ?? new Date();
  const name = `${ymd(date)} Jev capability review`;
  const file = path.join(vault, REVIEW_FOLDER, `${name}.md`);
  writeAtomic(file, renderNote(input));

  const byId = new Map(input.result.shortlist.map((c) => [c.item.key, c]));
  const itemNotes: string[] = [];
  for (const d of input.result.decisions) {
    if (d.decision !== "adopt" && d.decision !== "pilot") continue;
    const c = byId.get(d.id);
    if (!c) continue;
    const target = path.join(vault, REVIEW_FOLDER, `${linkSafe(c.item.title)}.md`);
    try {
      writeFileSync(
        target,
        [`---`, `tags: [jev, candidate]`, `firstSeen: ${ymd(date)}`, `source: ${c.item.url}`, `---`, "", `# ${c.item.title}`, "", `${c.scout.claim}`, "", `**${d.decision}** — ${d.why}`, "", c.survey ? `Where Jev is today: ${c.survey.verdict} (nearest: \`${c.survey.nearest}\`). It would add: ${c.survey.gap}` : "", "", `First raised in [[${name}]].`, ""].join("\n"),
        { flag: "wx" },
      );
      itemNotes.push(target);
    } catch {
      /* already exists — an earlier review raised it, and the user may have written on it since */
    }
  }

  appendToIndex(vault, name, date, input);

  const vaultName = path.basename(vault);
  return { file, uri: `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(`${REVIEW_FOLDER}/${name}`)}`, itemNotes };
}

/** Every note ends with "See [[Jev Capability Index]] for how this has changed over time", so
 *  something has to write it. A promise in a document that nothing keeps is how `hermes.ts:59`
 *  came to tell the brain it could read pages it could not. */
function appendToIndex(vault: string, noteName: string, date: Date, input: PublishInput): void {
  const file = path.join(vault, REVIEW_FOLDER, `${INDEX_NOTE}.md`);
  const adopted = input.result.decisions.filter((d) => d.decision === "adopt" || d.decision === "pilot");
  const names = adopted
    .map((d) => input.result.shortlist.find((c) => c.item.key === d.id)?.item.title)
    .filter(Boolean)
    .join(", ");
  const line = `- [[${noteName}]] — ${input.harvest.fresh.length} new, ${input.result.shortlist.length} shortlisted, ${adopted.length} worth doing${names ? `: ${names}` : ""}. Surfaces: ${input.manifest.executors.length}${input.manifest.planned.length ? ` (+${input.manifest.planned.length} declared-only)` : ""}, ${input.manifest.actions.length} fast-lane actions, ${input.manifest.brainTools.length} brain tools.\n`;
  try {
    const existing = readFileSync(file, "utf8");
    // idempotent: re-running a review on the same day replaces its line rather than adding another
    const without = existing.split("\n").filter((l) => !l.includes(`[[${noteName}]]`)).join("\n").replace(/\n+$/, "\n");
    writeAtomic(file, `${without}${line}`);
  } catch {
    writeAtomic(file, [`---`, `tags: [jev, capability-review, index]`, `---`, "", `# ${INDEX_NOTE}`, "", `What each twice-weekly review decided, and what Jev could do at the time. Newest at the bottom.`, "", line].join("\n"));
  }
}

/** The Slack line. Short on purpose: the note is the document, this is the nudge. */
export function renderSlack(input: PublishInput, note: WrittenNote): string {
  const adopted = input.result.decisions.filter((d) => d.decision === "adopt" || d.decision === "pilot");
  const lines = [`*Jev capability review — ${ymd(input.date ?? new Date())}*`, `${input.harvest.fresh.length} new items, ${input.result.shortlist.length} shortlisted, ${adopted.length} worth doing.`];
  if (input.harvest.staleWarning) lines.push(`:warning: ${input.harvest.staleWarning}`);
  for (const d of adopted) {
    const c = input.result.shortlist.find((s) => s.item.key === d.id);
    lines.push(`• *${d.decision}* — ${c ? `<${c.item.url}|${c.item.title}>` : d.id}: ${d.why}`);
  }
  if (adopted.length === 0) lines.push("_Nothing met the bar this time._");
  lines.push(`Full note (with the disagreements): \`${note.file}\``);
  return lines.join("\n");
}

/** Never fails the run. The note is already on disk by the time this is called; a missing webhook
 *  or a 500 from Slack is worth reporting, not worth losing a review over. */
export async function postSlack(text: string, webhook = process.env.JEV_REVIEW_SLACK_WEBHOOK, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!webhook?.trim()) return "slack: skipped (no JEV_REVIEW_SLACK_WEBHOOK set)";
  try {
    const res = await fetchImpl(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(15_000) });
    return res.ok ? "slack: posted" : `slack: failed (HTTP ${res.status})`;
  } catch (err) {
    return `slack: failed (${err instanceof Error ? err.message : String(err)})`;
  }
}
