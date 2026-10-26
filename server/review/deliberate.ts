/** The deliberation: three agents, a fixed number of rounds, nothing open-ended.
 *
 *  the user's shape, in his own words: "an agent that ingests, goes through, looks at all the stuff
 *  that's new, and brings it into an agent who goes through and categorizes" · "another agent goes
 *  through and compares what we have versus what is new" · "another agent will deliberate with the
 *  agent who's categorizing on what actually needs to be done, what's actually going to provide
 *  more value, and what's actually going to be of help."
 *
 *  Implemented the same way v7's task loop is: the loop is deterministic and each agent answers a
 *  bounded question. "Deliberate" is a scripted exchange with a rebuttal round, not an open
 *  conversation between two agents — so a review cannot run away, a malformed answer costs one
 *  item rather than the run, and the disagreement is captured rather than averaged away.
 *
 *    Scout    (one-shot)  categorises the new harvest and shortlists.
 *    Surveyor (one-shot)  diffs each shortlisted item against the generated capability manifest.
 *    Arbiter  (model)     proposes, hears the Scout's rebuttal, then decides.
 *
 *  The rubric every judgement is made against is the user's stated purpose: Jev is the system-1
 *  worker and browser automation is how it does as many tasks as possible. A candidate earns a
 *  place only if it makes Jev a better worker. */
import { z } from "zod";
import type { OneShot } from "../brain/oneshot.js";
import type { Arbiter } from "./arbiter.js";
import { type FilterVerdict, screenItem } from "./filters.js";
import type { Finding } from "./investigate.js";
import { type Manifest, describeManifest } from "./manifest.js";
import type { SheetRow, WatchItem } from "./sheet.js";

export const PURPOSE = `Jev is a Mac productivity assistant. the user's stated purpose for it: "to use Jev and browser automation, with Jev being a representation of a system 1 model and browser automation being the opportunity to do as many tasks for efficiency and productivity in the workforce as possible" — Jev as a super worker he can pass tasks off to at scale. Judge every candidate by whether it makes Jev a better system-1 worker at real tasks on a real computer.`;

/** The watch pipeline's own taxonomy, so the review's categories line up with the daily digest's. */
export const CATS = ["model-core", "harness-sdk", "browser-use", "computer-use", "cloud-computer", "tutorial", "research", "commentary", "other"] as const;

/** One Scout answer, validated on its own.
 *
 *  Deliberately NOT nested inside the envelope schema. v8 already learned this on the Arbiter — "one
 *  malformed item binned the whole round", where real Hermes answered `"high (fills a real gap)"` for
 *  one item's value and took three sound judgements down with it — and the Scout was left with the
 *  old shape. Here it costs more: a strict array means one empty `claim` in fifteen fails the parse,
 *  burns OneShot's stricter retry, and then loses all fifteen rows to a single bad field. */
const scoutItemSchema = z.object({
  id: z.string().min(1),
  category: z.enum(CATS).catch("other"),
  claim: z.string().min(1),
  whyItMightMatter: z.string().min(1),
  shortlist: z.boolean(),
});

/** The envelope only. Items are checked one at a time, below. */
const scoutSchema = z.object({ items: z.array(z.unknown()) });

/** Bend one answer into the shape before judging it.
 *
 *  The normal answer is already correct — probed live against the real prompt and rows: right keys,
 *  boolean `shortlist`, nothing empty. But a live run lost THREE near-whole batches (15 of 15, 15 of
 *  15, 14 of 15) to per-item validation, so some responses come back shaped differently and it is not
 *  reproducible on demand. Same move v8 made on the Arbiter, where real Hermes answered
 *  `"high (fills a real gap)"` and a strict enum binned three sound judgements: normalise first, judge
 *  after. Only `id` is genuinely required — it is identity, and an answer that cannot be attached to a
 *  row is worthless. A thin claim is worth keeping; fifteen rows lost to a renamed key is not. */
export function normalizeScoutItem(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  const pick = (...keys: string[]) => keys.map((k) => v[k]).find((x) => typeof x === "string" && x.trim() !== "") as string | undefined;
  const raw = v.shortlist ?? v.short_list ?? v.shouldShortlist;
  // `shortlist` is the VERDICT, so it is read and never defaulted. Falling back to false would
  // invent a "no" for a row the model never judged: the item would validate, land in `considered`,
  // and the watermark would step past it — silently rejecting a row instead of holding it, which is
  // the exact failure this whole normalisation exists to avoid. Anything unrecognised yields
  // undefined, the item fails validation, and the row is held.
  const shortlist =
    typeof raw === "boolean"
      ? raw
      : typeof raw === "number" && (raw === 0 || raw === 1)
        ? raw === 1
        : typeof raw === "string" && /^(true|false|yes|no|y|n)$/i.test(raw.trim())
          ? /^(true|yes|y)$/i.test(raw.trim())
          : undefined;
  return {
    id: pick("id", "url", "key", "rowId", "row_id") ?? "",
    category: v.category ?? v.cat ?? v.kind,
    // A thin claim is worth keeping once a real verdict exists; it is not worth losing the row over.
    claim: pick("claim", "what", "whatItIs", "what_it_is", "description", "summary") ?? "no claim given",
    whyItMightMatter: pick("whyItMightMatter", "why_it_might_matter", "why", "whyItMatters", "why_it_matters", "rationale") ?? "no reason given",
    shortlist,
  };
}
export type ScoutCall = z.infer<typeof scoutItemSchema>;

const surveySchema = z.object({
  id: z.string().min(1),
  verdict: z.enum(["have", "partial", "seam-only", "gap"]),
  nearest: z.string(),
  gap: z.string(),
});
export type Survey = z.infer<typeof surveySchema>;

const ORDINAL = ["high", "medium", "low"] as const;

/** A live run had the Arbiter answer "high (fills a real gap)" for one item's value, and a strict
 *  enum threw away the whole round — including three perfectly good judgements — over what is a
 *  formatting difference, not a disagreement. Normalise the shape; keep the meaning. */
const ordinal = z.preprocess((v) => {
  const s = String(v ?? "").toLowerCase().trim();
  const hit = ORDINAL.find((o) => s.startsWith(o) || s.includes(o));
  if (hit) return hit;
  if (/^(5|4|very high|significant)/.test(s)) return "high";
  if (/^(1|2|very low|none|minimal|trivial)/.test(s)) return "low";
  if (/^(3|moderate|med\b)/.test(s)) return "medium";
  return s;
}, z.enum(ORDINAL));

const proposalItemSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(["adopt", "pilot", "watch", "reject"]),
  value: ordinal,
  effort: ordinal,
  risk: ordinal,
  why: z.string().min(1),
});
export type Proposal = z.infer<typeof proposalItemSchema>;

/** Validated per item on purpose. The Arbiter answering badly about ONE candidate must cost that
 *  candidate, not the round — the same rule the task loop follows for a row that fails. */
const proposalSchema = z.object({ items: z.array(z.unknown()).min(1) });

export function parseProposals(raw: unknown[]): { ok: Proposal[]; bad: string[] } {
  const ok: Proposal[] = [];
  const bad: string[] = [];
  for (const entry of raw) {
    const parsed = proposalItemSchema.safeParse(entry);
    if (parsed.success) ok.push(parsed.data);
    else bad.push(`${(entry as { id?: string })?.id ?? "an unnamed item"} (${parsed.error.issues.map((i) => i.path.join(".")).join(", ")})`);
  }
  return { ok, bad };
}

const rebuttalSchema = z.object({ replies: z.array(z.object({ id: z.string().min(1), stance: z.enum(["defend", "concede"]), argument: z.string().min(1) })) });
export type Rebuttal = z.infer<typeof rebuttalSchema>["replies"][number];

const SCOUT_SYSTEM = `You triage a research feed about browser agents, computer-use tooling and cloud computers for one Mac productivity app.
${PURPOSE}
Answer as JSON only: {"items":[{"id","category","claim","whyItMightMatter","shortlist"}]}. One entry per row you were given, same ids, no extras.
- category: one of ${CATS.join(", ")}.
- claim: what the thing IS, in one clause, from the row itself. Never speculate beyond what the row says.
- whyItMightMatter: one clause on what it could change for a Mac assistant that drives a real browser and a real desktop. Say "unclear from this row" when the row does not support a claim.
- shortlist: true only for things that could plausibly change what the app can DO. Tutorials, commentary, funding news, benchmarks and reposts are false, however interesting.`;

const SURVEYOR_SYSTEM = `You compare one candidate against an inventory of what a Mac productivity app already has. The inventory is generated from its source code and is authoritative — never assume a capability that is not in it, and never treat an absence as an oversight.
Answer as JSON only: {"id","verdict","nearest","gap"}.
- verdict: "have" (the app already does this), "partial" (it does some of it), "seam-only" (the app has a declared interface or reserved name for this with nothing implemented behind it), or "gap" (nothing like it).
- nearest: the closest real thing in the inventory, cited by its file path or identifier exactly as the inventory writes it. Use "nothing comparable" only for a true gap.
- gap: what the candidate would add that the inventory does not already cover, in one sentence. For "have", say what makes it redundant.`;

const ARBITER_INSTRUCTIONS = `You are the deciding half of a twice-weekly capability review for Jev, the user's Mac productivity assistant. Two other agents have done the legwork: a Scout categorised what is new, a Surveyor diffed each candidate against an inventory generated from Jev's own source code.
${PURPOSE}
Decide what is worth doing. You are not writing a summary and you are not being diplomatic — the point of this review is to say no to most things. Rules you do not get to relax:
- The Surveyor's inventory is generated from code and is authoritative. If it says Jev already has something, it does.
- Jev owns its task loop; models only answer bounded questions. Anything that wants to be the thing in charge can at best be an engine behind Jev's executor seam.
- Jev does its own data gathering with a browser. Paid enrichment answer-databases are never adopted.
- "watch" is a real and common answer. "adopt" means it is worth doing next; "pilot" means one bounded experiment would settle it.
Answer as JSON only, exactly the shape asked for, with no prose around it.`;

export interface Candidate {
  item: WatchItem;
  scout: ScoutCall;
  survey: Survey | null;
  finding: Finding | null;
  ranked: SheetRow | null;
  /** Set when a standing rule decided this in code, before any model judged it. */
  filtered: FilterVerdict | null;
}

export interface Decision extends Proposal {
  /** Present when the Scout was asked to defend a claim the Arbiter doubted. */
  rebuttal?: Rebuttal;
  /** True when the decision came from a standing rule rather than the Arbiter's judgement. */
  byRule: boolean;
}

export interface DeliberationResult {
  categorised: ScoutCall[];
  shortlist: Candidate[];
  decisions: Decision[];
  /** Everything that went wrong without stopping the run; carried into the note. */
  problems: string[];
  /** What the investigation pass read, and anything it wants said out loud. */
  findings: Finding[];
  investigationNote: string | null;
  /** Rows an agent actually looked at and answered on. ONLY these may advance the watermark — a
   *  row lost to a failed Scout batch or cut by the shortlist cap must come back next time. */
  considered: WatchItem[];
  /** Eligible rows that got no answer at all — a failed Scout batch, a row cut by the cap, or one
   *  the model left out of its reply. The watermark must be held below the oldest of these. */
  unconsidered: WatchItem[];
  /** Shortlisted but cut by the cap. Named in the note so they are visibly deferred, not dropped. */
  overflow: WatchItem[];
}

export interface DeliberateDeps {
  oneshot: OneShot;
  arbiter: Arbiter;
  manifest: Manifest;
  /** How many harvest rows go into one Scout call. */
  batchSize?: number;
  maxShortlist?: number;
  /** Progress, so a long run is visibly alive in last-run.log. */
  log?: (line: string) => void;
  scoutBudgetMs?: number;
  scoutConcurrency?: number;
  now?: () => number;
  /** Jev opens and reads the shortlisted pages. Called AFTER the Scout narrows the field and
   *  BEFORE the Surveyor judges, because both the diff and the standing-rule screen are much
   *  sharper against what a vendor's own page says than against a headline. Omit it and the
   *  review still runs, judging from the Sheet alone. */
  investigate?: (shortlist: WatchItem[]) => Promise<{ findings: Finding[]; note: string | null }>;
}

/** Rows per Scout call.
 *
 *  Halved from 15 on the evidence of the first full run: 4 of 35 batches (~11%) hit the 4-minute
 *  per-call timeout, and each one cost 15 rows. The call is generation-bound, so half the rows is
 *  roughly half the output and a materially better chance of finishing — and when one does time out
 *  it costs 8 rows instead of 15. It doubles the call count, but the calls run 8 at a time, so the
 *  wall clock is comparable while the losses are not. */
const SCOUT_BATCH = 8;
/** A wall-clock ceiling on the Scout pass.
 *
 *  A real intake is ~136 sequential calls and each one may sit on OneShot's 4-minute timeout, so
 *  nothing structural stopped a bad afternoon from running for nine hours — against this design's own
 *  rule that a review cannot run away. When the budget is spent the remaining rows are simply not
 *  scouted, which means they never enter `considered`, which means `unconsidered` holds the watermark
 *  below them and they come round next run. No new bookkeeping: the existing machinery already
 *  treats "eligible but unanswered" as held. */
export const SCOUT_BUDGET_MS = 45 * 60_000;

/** How many Scout batches are in flight at once.
 *
 *  Sized off the LIVE run, because every cheaper estimate was wrong and wrong in the same direction.
 *  An isolated 15-row probe said 9.5s. Inferring from the first run's 38 minutes said ~17s. Actually
 *  watching batches start and finish says **~120s** — the real call carries the whole SCOUT_SYSTEM
 *  prompt and fifteen 300-char summaries, and answers with 1,100+ tokens, so it is generation-bound
 *  and trimming the prompt buys nothing.
 *
 *  At 120s a batch, a 1,719-row first run is 115 batches: 3.8 hours sequentially, 57 minutes at four
 *  at a time, ~29 minutes at eight. Steady state is ~77 batches, so ~19 minutes. Eight it is, with a
 *  45-minute ceiling — comfortably above the normal run, which is the whole point of a ceiling.
 *  Deliberately not higher: this is a background job with nobody waiting, and a rate-limited review
 *  is worse than a slow one. Batch results are merged by id, so completion order does not matter.
 *  Deliberately modest: this is a background job with nobody waiting, and a rate-limited review is
 *  worse than a slow one. Batch results are merged by id, so completion order does not matter. */
export const SCOUT_CONCURRENCY = 8;
const MAX_SHORTLIST = 12;

const row = (i: WatchItem) => `id=${i.key} | ${i.title} | ${i.url} | ${(i.summary ?? "").slice(0, 300)}`;

/** ── Pass 1: the Scout ─────────────────────────────────────────────────────────────────────── */
export async function scout(oneshot: OneShot, items: WatchItem[], batchSize = SCOUT_BATCH, problems: string[] = [], log?: (line: string) => void, budgetMs = SCOUT_BUDGET_MS, now = () => Date.now(), concurrency = SCOUT_CONCURRENCY): Promise<ScoutCall[]> {
  const out: ScoutCall[] = [];
  // A real intake is ~136 sequential calls and ten minutes. Without a line per batch, last-run.log
  // shows "deliberating…" and then nothing, so a hung run and a working one look identical — which
  // is the failure this project keeps meeting in new places.
  const slices: Array<{ n: number; at: number; rows: WatchItem[] }> = [];
  for (let i = 0; i < items.length; i += batchSize) slices.push({ n: slices.length + 1, at: i, rows: items.slice(i, i + batchSize) });
  const batches = slices.length;
  const deadline = now() + budgetMs;
  let next = 0;
  let done = 0;
  let abandoned = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const slice = slices[next++];
      if (!slice) return;
      if (now() > deadline) {
        // Not a failure: these rows were never looked at, so they never enter `considered`, which is
        // what holds the watermark below them and brings them back next run.
        abandoned += slice.rows.length;
        continue;
      }
      log?.(`  scouting batch ${slice.n}/${batches} (${done} done, ${out.length} categorised so far)`);
      try {
        const { items: raw } = await oneshot.json(SCOUT_SYSTEM, `New rows:\n${slice.rows.map(row).join("\n")}`, scoutSchema);
        const known = new Set(slice.rows.map((b) => b.key));
        const answered = new Set<string>();
        for (const candidate of raw) {
          const parsed = scoutItemSchema.safeParse(normalizeScoutItem(candidate));
          // A bad answer costs that row, not its fourteen neighbours.
          if (!parsed.success) continue;
          if (!known.has(parsed.data.id)) continue;
          if (answered.has(parsed.data.id)) continue;
          answered.add(parsed.data.id);
          out.push(parsed.data);
        }
        // Counted against the rows SENT, not against the answers returned, because the common case
        // is the model quietly answering about fewer rows than it was given — observed live at ~15%
        // on real content. Those rows are held (they never reach `considered`, so the watermark stays
        // below them), but held-and-unreported is how a backlog grows with nobody noticing.
        const missing = slice.rows.length - answered.size;
        // The cause of a whole-batch loss is still unconfirmed — a direct probe of this prompt
        // returns a perfectly shaped 15/15 — so when one happens, write down what the answers
        // actually looked like instead of guessing again next time.
        if (answered.size === 0 && raw.length) {
          const first = raw[0] as Record<string, unknown> | null;
          const shape = first && typeof first === "object" ? `keys=${Object.keys(first).join(",")} shortlist=${typeof (first.shortlist ?? first.short_list)}` : `not an object (${typeof first})`;
          const why = `the Scout answered about rows ${slice.at + 1}–${slice.at + slice.rows.length} in a shape nothing could use: ${shape}`;
          problems.push(why);
          log?.(`  ! ${why}`);
        }
        if (missing) {
          const why = `the Scout gave no usable answer for ${missing} of the ${slice.rows.length} rows ${slice.at + 1}–${slice.at + slice.rows.length}; those rows are held for the next review`;
          problems.push(why);
          log?.(`  ! ${why}`);
        }
      } catch (err) {
        // a batch that fails costs those rows, not the review — and it is written down
        const why = `the Scout could not read rows ${slice.at + 1}–${slice.at + slice.rows.length}: ${err instanceof Error ? err.message : String(err)}`;
        problems.push(why);
        // and said NOW, not only in the note: a run where half the batches are failing their schema
        // retry looks, from the log, exactly like a run that is merely slow.
        log?.(`  ! ${why}`);
      }
      done++;
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, batches)) }, worker));
  if (abandoned) {
    problems.push(`the Scout ran out of its ${Math.round(budgetMs / 60_000)}-minute budget after ${done} of ${batches} batches; the remaining ${abandoned} row(s) were not looked at and are held for the next review`);
  }
  return out;
}

/** ── Pass 2: the Surveyor ──────────────────────────────────────────────────────────────────── */
export async function survey(oneshot: OneShot, manifest: Manifest, candidates: Array<{ item: WatchItem; scout: ScoutCall; finding: Finding | null }>, problems: string[] = []): Promise<Map<string, Survey>> {
  const inventory = describeManifest(manifest);
  const found = new Map<string, Survey>();
  for (const c of candidates) {
    try {
      const read = c.finding?.answer ? `\nWhat Jev read on the page: ${c.finding.answer}` : "";
      found.set(c.item.key, await oneshot.json(SURVEYOR_SYSTEM, `Inventory of what Jev already has:\n${inventory}\n\nCandidate (id=${c.item.key}):\n${c.item.title} — ${c.item.url}\n${c.scout.claim}${read}`, surveySchema));
    } catch (err) {
      problems.push(`the Surveyor could not judge "${c.item.title}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return found;
}

/** ── Pass 3: the Arbiter, in three rounds ──────────────────────────────────────────────────── */
const brief = (c: Candidate) =>
  [
    `id=${c.item.key} — ${c.item.title} (${c.item.url})`,
    `  Scout: ${c.scout.category}; ${c.scout.claim}; might matter because ${c.scout.whyItMightMatter}`,
    c.survey ? `  Surveyor: ${c.survey.verdict} — nearest is ${c.survey.nearest}; it would add: ${c.survey.gap}` : `  Surveyor: could not judge this one`,
    c.finding?.answer ? `  Jev read the page: ${c.finding.answer}` : c.finding ? `  Jev could not read the page: ${c.finding.error ?? "no reason given"}` : `  the page was not opened`,
    c.ranked?.score ? `  the daily pipeline scored it ${c.ranked.score}${c.ranked.ranknote ? ` (${c.ranked.ranknote})` : ""}` : null,
    c.filtered ? `  A STANDING RULE already applies: ${c.filtered.kind === "reject" ? "REJECTED" : "FLAGGED"} — ${c.filtered.reason}` : null,
  ]
    .filter(Boolean)
    .join("\n");

/** Which proposals are worth challenging: the Arbiter and the Scout disagree about worth, so the
 *  Scout gets one chance to defend the claim. This is the deliberation, and it is the part of the
 *  note most worth reading — so it is never summarised away. */
export function contested(candidates: Candidate[], proposals: Proposal[]): Proposal[] {
  const byId = new Map(candidates.map((c) => [c.item.key, c]));
  return proposals.filter((p) => {
    const c = byId.get(p.id);
    if (!c || c.filtered?.kind === "reject") return false; // a rule is not up for debate
    const scoutIsKeen = c.scout.shortlist;
    const arbiterSaysNo = p.decision === "reject" || p.decision === "watch";
    const surveyorSaysRedundant = c.survey?.verdict === "have";
    return (scoutIsKeen && arbiterSaysNo) || (surveyorSaysRedundant && (p.decision === "adopt" || p.decision === "pilot"));
  });
}

export async function deliberate(items: WatchItem[], ranked: Map<string, SheetRow>, deps: DeliberateDeps): Promise<DeliberationResult> {
  const problems: string[] = [];

  const categorised = await scout(deps.oneshot, items, deps.batchSize ?? SCOUT_BATCH, problems, deps.log, deps.scoutBudgetMs, deps.now, deps.scoutConcurrency);
  const byId = new Map(items.map((i) => [i.key, i]));

  // Cap by the pipeline's own score, not by whatever order the Sheet happened to be in — and keep
  // what falls off, so the note can say it was deferred rather than quietly losing it.
  const scoreOf = (k: string) => Number(ranked.get(k)?.score ?? 0) || 0;
  const wanted = categorised.filter((c) => c.shortlist && byId.has(c.id)).sort((a, b) => scoreOf(b.id) - scoreOf(a.id));
  const limit = deps.maxShortlist ?? MAX_SHORTLIST;
  const chosen = wanted.slice(0, limit);
  const overflow = wanted.slice(limit).map((c) => byId.get(c.id)!);
  if (overflow.length) problems.push(`${overflow.length} shortlisted item(s) were over the ${limit}-per-review cap and are held for next time, lowest-scoring first: ${overflow.map((o) => o.title).join("; ")}`);

  // Jev reads the pages now that there is a narrowed list to read.
  let findings: Finding[] = [];
  let investigationNote: string | null = null;
  if (deps.investigate && chosen.length) {
    try {
      ({ findings, note: investigationNote } = await deps.investigate(chosen.map((c) => byId.get(c.id)!)));
    } catch (err) {
      problems.push(`Jev could not open the shortlisted pages: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const findingFor = new Map(findings.map((f) => [f.id, f]));
  const picked = chosen.map((scoutCall) => ({ item: byId.get(scoutCall.id)!, scout: scoutCall, finding: findingFor.get(scoutCall.id) ?? null }));

  const surveys = await survey(deps.oneshot, deps.manifest, picked, problems);

  const shortlist: Candidate[] = picked.map((p) => ({
    ...p,
    survey: surveys.get(p.item.key) ?? null,
    ranked: ranked.get(p.item.key) ?? null,
    // screened over everything known, including what Jev read off the vendor's own page — which
    // says what a product sells far more plainly than a headline does
    filtered: screenItem([p.item.title, p.item.summary, p.scout.claim, p.scout.whyItMightMatter, p.finding?.answer]),
  }));

  const deferred = new Set(overflow.map((o) => o.key));
  const considered = categorised.map((c) => byId.get(c.id)).filter((i): i is WatchItem => !!i && !deferred.has(i.key));
  // Defined as "everything eligible that did not get an answer", not as a list of known failure
  // modes. That way a failed Scout batch, a row cut by the cap and a row the model simply left out
  // of an otherwise successful answer are all covered by construction — and the watermark is held
  // below the oldest of them, because batches succeed out of date order.
  const answered = new Set(considered.map((i) => i.key));
  const unconsidered = items.filter((i) => !answered.has(i.key));
  const carry = { categorised, shortlist, problems, findings, investigationNote, considered, unconsidered, overflow };
  if (shortlist.length === 0) return { ...carry, decisions: [] };

  // Round 1 — the Arbiter proposes.
  let proposals: Proposal[];
  try {
    const { items: got } = await deps.arbiter.json(proposalSchema, `Candidates:\n\n${shortlist.map(brief).join("\n\n")}\n\nFor each id, answer {"id","decision","value","effort","risk","why"}. value, effort and risk are exactly one of high, medium or low — one bare word, nothing in brackets. Reply as {"items":[...]}.`, ARBITER_INSTRUCTIONS);
    const round1 = parseProposals(got);
    if (round1.bad.length) problems.push(`the Arbiter's first answer was unusable for ${round1.bad.join("; ")}`);
    proposals = round1.ok.filter((p) => shortlist.some((c) => c.item.key === p.id));
    if (proposals.length === 0) throw new Error(`nothing in the Arbiter's answer could be read (${round1.bad.join("; ") || "no items"})`);
  } catch (err) {
    problems.push(`the Arbiter could not propose: ${err instanceof Error ? err.message : String(err)}`);
    // the rules still stand even when the reasoner is unreachable — those verdicts are code's
    return { ...carry, decisions: ruleOnly(shortlist) };
  }

  // Round 2 — one rebuttal round, only where they actually disagree.
  const challenges = contested(shortlist, proposals);
  const rebuttals = new Map<string, Rebuttal>();
  if (challenges.length) {
    const byId2 = new Map(shortlist.map((c) => [c.item.key, c]));
    try {
      const { replies } = await deps.oneshot.json(
        `You are the Scout in a capability review. You shortlisted these as worth doing and the deciding agent disagreed. For each, either defend your claim with a concrete reason or concede. Conceding is respectable and common; do not defend something you cannot support from the evidence given.\n${PURPOSE}\nAnswer as JSON only: {"replies":[{"id","stance","argument"}]}.`,
        challenges.map((p) => `id=${p.id}\n${brief(byId2.get(p.id)!)}\n  The deciding agent said: ${p.decision} (value ${p.value}, effort ${p.effort}, risk ${p.risk}) because ${p.why}`).join("\n\n"),
        rebuttalSchema,
      );
      for (const r of replies) rebuttals.set(r.id, r);
    } catch (err) {
      problems.push(`the Scout could not answer the challenge: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Round 3 — the Arbiter decides, having heard the rebuttal.
  let finalItems = proposals;
  if (rebuttals.size) {
    try {
      const { items: revised } = await deps.arbiter.json(
        proposalSchema,
        `The Scout has answered your challenges:\n\n${[...rebuttals.values()].map((r) => `id=${r.id} — ${r.stance}: ${r.argument}`).join("\n\n")}\n\nGive your FINAL decision for every candidate, including the ones nobody challenged. Change your mind where the argument is good; say plainly in "why" when it did not move you. value, effort and risk are exactly one of high, medium or low — one bare word, nothing in brackets. Reply as {"items":[...]}.`,
        ARBITER_INSTRUCTIONS,
      );
      const round3 = parseProposals(revised);
      if (round3.bad.length) problems.push(`the Arbiter's final answer was unusable for ${round3.bad.join("; ")}, so its earlier call stands for those`);
      const keep = new Map(round3.ok.filter((p) => shortlist.some((c) => c.item.key === p.id)).map((p) => [p.id, p]));
      finalItems = proposals.map((p) => keep.get(p.id) ?? p);
    } catch (err) {
      problems.push(`the Arbiter could not deliver a final decision, so its first proposal stands: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // The standing rules have the last word, over the Arbiter's judgement.
  const decisions: Decision[] = finalItems.map((p) => {
    const c = shortlist.find((s) => s.item.key === p.id)!;
    const rebuttal = rebuttals.get(p.id);
    if (c.filtered?.kind === "reject") return { ...p, decision: "reject", why: c.filtered.reason, byRule: true, ...(rebuttal ? { rebuttal } : {}) };
    if (c.filtered?.kind === "flag" && (p.decision === "adopt" || p.decision === "pilot")) return { ...p, why: `${p.why} — but ${c.filtered.reason}`, byRule: true, ...(rebuttal ? { rebuttal } : {}) };
    return { ...p, byRule: false, ...(rebuttal ? { rebuttal } : {}) };
  });

  return { ...carry, decisions };
}

/** What the standing rules alone can say when the Arbiter is unreachable. */
function ruleOnly(shortlist: Candidate[]): Decision[] {
  return shortlist
    .filter((c) => c.filtered?.kind === "reject")
    .map((c) => ({ id: c.item.key, decision: "reject" as const, value: "low" as const, effort: "low" as const, risk: "low" as const, why: c.filtered!.reason, byRule: true }));
}
