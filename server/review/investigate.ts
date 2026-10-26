/** The investigation pass: Jev's own browser reads the shortlisted candidates.
 *
 *  Each shortlisted page is fetched through browser-box (plain HTTP first; a real browser when the
 *  page needs JavaScript), then one bounded question to the model pulls out the only thing the
 *  Arbiter needs — so the deliberation argues from pages that were actually read, not from Sheet
 *  summaries a model wrote about a title.
 *
 *  v11 dropped the old route (POST /api/task on the Jev app); since the cutover every item was
 *  quietly judged "from the Sheet alone". This reads through browser-box directly, so the review no
 *  longer needs the Jev app to be running either.
 *
 *  Rules that are not negotiable, enforced here:
 *  1. Only public pages, through Jev's OWN browser — never the user's Chrome, never his screen.
 *  2. Candidate code is never executed: fetch/read load and read a page; that is the whole contract. */
import { z } from "zod";
import type { OneShot } from "../brain/oneshot.js";
import type { BoxResult, BrowserBox } from "../browserbox.js";
import type { WatchItem } from "./sheet.js";

/** A review that opens fifty pages every Monday is a review nobody reads; the shortlist narrows. */
export const MAX_INVESTIGATED = 12;
/** Pages read at once: enough to finish in a minute or two, few enough to be polite. */
export const CONCURRENCY = 4;
/** Per page, fetch + read + the model's answer. */
export const PER_ITEM_MS = 90_000;
/** Page text handed to the model per candidate. */
const MAX_PAGE_CHARS = 10_000;

export const FIELD = "what it actually does, what it requires (a paid account, an API key, or a login), and whether it wants to own the agent loop";

export interface Finding {
  id: string;
  url: string;
  status: "ok" | "failed" | "skipped" | "not-investigated";
  /** What was read off the page, or null when it could not say. */
  answer: string | null;
  error: string | null;
}

export interface InvestigateOptions {
  box: BrowserBox | null;
  oneshot: OneShot;
  max?: number;
  perItemMs?: number;
}

const answerSchema = z.object({ answer: z.string().nullable() });

const SYSTEM = `You read one web page about a software tool, repo or article and answer one question about it, as JSON only: {"answer": "..."} — or {"answer": null} when the page does not say.
The question: ${FIELD}.
Two or three plain sentences. Say only what the page says; do not guess, do not sell it.`;

/** Nothing opened is reported as such, per item. A thinner review that says so is fine; one that
 *  silently looks complete is the failure mode this project keeps hitting. */
const notInvestigated = (items: WatchItem[], why: string): Finding[] => items.map((i) => ({ id: i.key, url: i.url, status: "not-investigated" as const, answer: null, error: why }));

/** The page's text, cheapest first: plain HTTP, then a real browser when that came back thin. */
async function pageText(box: BrowserBox, url: string, signal: AbortSignal): Promise<{ text: string; title: string }> {
  const text = (r: BoxResult) => String(r.text ?? "").trim();
  const first = await box.call("fetch", { url }, signal).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }) as BoxResult);
  if (text(first).length >= 400) return { text: text(first), title: String(first.title ?? "") };
  const second = await box.call("read", { url }, signal);
  if (!text(second)) throw new Error(`the page had no readable text${first.error ? ` (fetch: ${String(first.error)})` : ""}`);
  return { text: text(second), title: String(second.title ?? "") };
}

async function readOne(item: WatchItem, opts: InvestigateOptions): Promise<Finding> {
  const signal = AbortSignal.timeout(opts.perItemMs ?? PER_ITEM_MS);
  try {
    const page = await pageText(opts.box!, item.url, signal);
    const clipped = page.text.length > MAX_PAGE_CHARS ? `${page.text.slice(0, MAX_PAGE_CHARS)}\n… (cut)` : page.text;
    const { answer } = await opts.oneshot.json(SYSTEM, `${page.title} — ${item.url}\n\n${clipped}`, answerSchema);
    return { id: item.key, url: item.url, status: "ok", answer, error: null };
  } catch (err) {
    return { id: item.key, url: item.url, status: "failed", answer: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function investigate(shortlist: WatchItem[], opts: InvestigateOptions): Promise<{ findings: Finding[]; note: string | null }> {
  const items = shortlist.filter((i) => /^https?:\/\//i.test(i.url)).slice(0, opts.max ?? MAX_INVESTIGATED);
  if (items.length === 0) return { findings: [], note: "no shortlisted item had a usable URL to open" };
  if (!opts.box) return { findings: notInvestigated(items, "browser-box isn't set up here (no BB_TOKEN), so nothing was opened and read"), note: "browser-box isn't configured on this Mac, so the candidates below were judged from the Sheet alone." };
  try {
    await opts.box.call("status", null, AbortSignal.timeout(5_000));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { findings: notInvestigated(items, "browser-box wasn't running, so nothing was opened and read"), note: `browser-box wasn't answering (${why}), so the candidates below were judged from the Sheet alone.` };
  }
  const findings: Finding[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) findings[i] = await readOne(items[i]!, opts);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  const failed = findings.filter((f) => f.status !== "ok").length;
  return { findings, note: failed ? `${failed} of ${items.length} shortlisted pages could not be read; those were judged from the Sheet alone.` : null };
}
