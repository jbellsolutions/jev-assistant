/** Reading "what's new" out of the watch pipeline's published Google Sheet.
 *
 *  The Sheet is the contract between the two systems. The pipeline owns collection and ranking on
 *  its own scheduler host and rewrites the Sheet from SQLite on every sync; this review only ever
 *  reads it. That keeps the review off SSH, off the host's database, and working from exactly the
 *  artefact the user already looks at.
 *
 *  `all-items` is the tab to key on — sheets_sync.py documents it as "the raw harvest (every row in
 *  the database)", so it is complete rather than windowed and a Monday run can still see
 *  Thursday-through-Sunday. `ranked-items` is read alongside it for the pipeline's own score.
 *
 *  Everything here fails loudly. "0 new items" must never be the same observation as "the read
 *  didn't work" or "the daily pipeline died on Friday". */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { type ReviewState, cutoffMs, parseWhen } from "./state.js";

const run = promisify(execFile);

export const WATCH_SHEET_ID = process.env.JEV_WATCH_SHEET_ID || "YOUR_WATCH_SHEET_ID";

/** The `gws` on PATH is an ephemeral per-shell fnm symlink — launchd has no shell and will not
 *  find it. Prefer the stable install path, and let the environment override both. */
export const GWS_CANDIDATES = [process.env.GWS_BIN].filter(Boolean) as string[];

export function resolveGws(candidates = GWS_CANDIDATES): string {
  return candidates.find((c) => existsSync(c)) ?? "gws";
}

/** A row as the Sheet gives it, with the header row's own labels lower-cased into keys. */
export type SheetRow = Record<string, string>;

/** A harvest row, normalised.
 *
 *  The real `all-items` header, read from sheets_sync.py on 2026-09-24, is:
 *    PLATFORM, KIND, SOURCE, TITLE, AUTHOR, PUBLISHED, URL, SEEN, FIRST_SEEN, SUMMARY
 *  There is NO id column — the database's `id` never reaches the Sheet — and the DB's `fetched`
 *  is published as FIRST_SEEN. So the URL is the only stable identity available, and the date
 *  column has to be resolved by trying the names the pipeline might have used. Both `id` and
 *  `fetched` are hard-coded nowhere below for that reason. */
export interface WatchItem extends SheetRow {
  /** Stable identity across runs: the URL, because there is nothing better in the Sheet. */
  key: string;
  title: string;
  url: string;
  /** When the pipeline first saw it (FIRST_SEEN, or whatever it calls that now). */
  seenAt: string;
}

/** RFC4180-ish: quoted fields may contain commas, newlines and doubled quotes. Hand-rolled rather
 *  than a dependency, because the whole file is one function and a CSV parser is not the risk here. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/** The header labels are the pipeline's to choose and it has changed them before (the Jev-* tabs
 *  use SHOUTING LABELS). Match case- and separator-insensitively rather than hard-coding. */
const key = (label: string) => label.trim().toLowerCase().replace(/[\s_-]+/g, "");

export function toObjects(rows: string[][]): SheetRow[] {
  const [header, ...body] = rows;
  if (!header) throw new Error("the Sheet tab had no header row");
  const keys = header.map(key);
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

/** Names the pipeline has used, or might reasonably use, for "when we first saw this". Tried in
 *  order; the first one present on the row wins. */
const DATE_COLUMNS = ["firstseen", "fetched", "collected", "published"] as const;

export function requireColumns(rows: SheetRow[], tab: string): WatchItem[] {
  const first = rows[0];
  if (!first) throw new Error(`the Sheet tab "${tab}" came back with a header but no rows — the pipeline may have written an empty sync`);
  const have = Object.keys(first);
  const dateCol = DATE_COLUMNS.find((c) => c in first);
  const missing = [...(("url" in first) ? [] : ["url"]), ...(("title" in first) ? [] : ["title"]), ...(dateCol ? [] : [`one of ${DATE_COLUMNS.join("/")}`])];
  if (missing.length) throw new Error(`the Sheet tab "${tab}" is missing ${missing.join(" and ")} — it has ${have.join(", ")}. The pipeline's schema changed; the review cannot key on it.`);
  return rows
    .filter((r) => (r.url ?? "").trim())
    .map((r) => ({ ...r, key: r.url!.trim(), title: (r.title ?? "").trim() || r.url!.trim(), url: r.url!.trim(), seenAt: (r[dateCol!] ?? "").trim() }));
}

export interface ReadTabOptions {
  spreadsheet?: string;
  range?: string;
  gws?: string;
  /** Test seam: stand in for shelling out to gws. */
  exec?: (bin: string, args: string[]) => Promise<string>;
  /** Test seam for the public read. */
  fetch?: typeof fetch;
  /** Skip the public read entirely and go straight to gws. */
  noPublic?: boolean;
  /** Which path served the read, so a switch between them shows up in last-run.log. */
  log?: (line: string) => void;
}

/** gws prints a JSON error object on auth failure rather than exiting non-zero in every case, so
 *  check for both. The message must name the fix, because this is the one step only the user can do.
 *
 *  It names `logout` FIRST, and that order is the whole point. Observed on 2026-09-25 with gws 0.9.1:
 *  `gws auth login` completed the browser flow, printed
 *  `"Authentication successful. Encrypted credentials saved."`, and left the existing
 *  `credentials.enc` untouched — because it could not decrypt the stale one it already had. Following
 *  the obvious instruction therefore produces a success message and no change, forever. `gws auth
 *  status` is the only thing that distinguishes "authenticated" from "holding a file it cannot read". */
export const NOT_AUTHED =
  "gws cannot read its credentials — run `gws auth logout` first (a login on top of an undecryptable credentials.enc reports success and saves nothing), then `gws auth login`, then check `gws auth status` says encryption_valid: true, then re-run the review";

/** gws wraps its failures as {"error":{"code","message","reason"}}; quote the message it wrote
 *  rather than the JSON, so the log line reads as an instruction and not as a payload. */
export function gwsMessage(text: string): string {
  try {
    const open = text.indexOf("{");
    const close = text.lastIndexOf("}");
    const body = open >= 0 && close > open ? (JSON.parse(text.slice(open, close + 1)) as { error?: { message?: string } }) : null;
    if (body?.error?.message) return body.error.message;
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return text.replace(/\s+/g, " ").slice(0, 200);
}

/** What `gws auth status` says about the credential store, reduced to the one thing that matters:
 *  can it actually read the Sheet, and if not, which remedy applies.
 *
 *  Worth a subprocess of its own before the run starts, because the two failures look identical from
 *  the 401 and have different fixes — "never logged in" is a login, while "logged in, cannot decrypt"
 *  needs the logout first, and a launchd job that reaches neither the keyring nor a login session can
 *  be in the second state while a shell is in neither. */
export async function authTrouble(opts: ReadTabOptions = {}): Promise<string | null> {
  const bin = opts.gws ?? resolveGws();
  let out: string;
  try {
    out = opts.exec ? await opts.exec(bin, ["auth", "status"]) : (await run(bin, ["auth", "status"])).stdout;
  } catch (err) {
    const e = err as { message?: string; stdout?: string; stderr?: string };
    out = [e.stdout, e.stderr, e.message].filter(Boolean).join(" ") || String(err);
  }
  let status: { auth_method?: string; encryption_valid?: boolean; encryption_error?: string; plain_credentials_exists?: boolean } | null = null;
  try {
    const open = out.indexOf("{");
    const close = out.lastIndexOf("}");
    if (open >= 0 && close > open) status = JSON.parse(out.slice(open, close + 1));
  } catch {
    return null; // unreadable status is not itself evidence of trouble; let the read speak
  }
  if (!status) return null;
  if (status.auth_method === "none" && !status.plain_credentials_exists) {
    return "gws has no credentials at all — run `gws auth login` once in a terminal, then re-run the review";
  }
  // A plain credentials file wins over the encrypted one, so a broken encrypted store beside a
  // working plain file is not trouble — it is the route around the broken store.
  if (status.encryption_valid === false && !status.plain_credentials_exists) {
    return `${NOT_AUTHED} (gws auth status says: ${status.encryption_error ?? "encryption_valid: false"})`;
  }
  return null;
}

/** The Sheet read without any credential at all.
 *
 *  Google serves a link-shared spreadsheet's tab as CSV from the visualisation endpoint, with no
 *  OAuth, no keyring and no login session — which is the whole reason this path exists. gws 0.9.1 on
 *  this Mac writes a `credentials.enc` it then cannot decrypt in ANY later process (verified in
 *  the user's own interactive shell), and even a working shell login would not prove a launchd job can
 *  reach a credential store with no login session. An unauthenticated HTTPS GET has neither problem.
 *
 *  Verified live 2026-09-25 against the real watch Sheet: `all-items` 5,595 rows, `ranked-items` and
 *  `Jev-catalog` likewise, headers byte-identical to the ones pinned in the tests.
 *
 *  Worth the user knowing, since it is what makes this work: that Sheet is readable by anyone who has
 *  its id. Nothing here changed its sharing. */
export const PUBLIC_TIMEOUT_MS = 30_000;

export function publicCsvUrl(tab: string, spreadsheet = WATCH_SHEET_ID): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheet}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
}

/** The silent-success trap on this path, and the reason this function is not just `parseCsv(body)`.
 *
 *  A spreadsheet that is NOT link-shared answers this endpoint with HTTP 200 and a Google sign-in
 *  page. That HTML has no commas on its first line, so a CSV parser happily returns it as one row
 *  with one column — a "successful" read of a review with zero items and nothing to say it failed.
 *  A real tab always starts with the quoted header row. */
export function looksLikeCsv(body: string): boolean {
  const head = body.trimStart().slice(0, 400).toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.includes("<script")) return false;
  const first = body.trimStart().split(/\r?\n/, 1)[0] ?? "";
  return first.includes(",");
}

/** gviz renders a cell the sheet has typed as a date as `Date(2026,8,19,13,5,6)` — zero-based month,
 *  and unparseable by anything expecting ISO. The watch Sheet's FIRST_SEEN is text today, so this is
 *  defence against the user reformatting that column later: without it the watermark would silently
 *  stop advancing while every run still looked fine. */
export function normalizeGvizDate(value: string): string {
  const m = /^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/.exec(value.trim());
  if (!m) return value;
  const [y, mo, d, h, mi, sec] = m.slice(1).map((n) => (n === undefined ? 0 : Number(n)));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(mo! + 1)}-${pad(d!)}T${pad(h!)}:${pad(mi!)}:${pad(sec!)}`;
}

/** A column each tab has and the others do not.
 *
 *  gviz answers an unknown tab name with HTTP 200 and the FIRST tab of the spreadsheet — verified
 *  2026-09-25 by asking for "no-such-tab-xyz" and getting ranked-items back. That tab carries url,
 *  title and first_seen, so `requireColumns` would accept it happily and the review would run
 *  against the pipeline's ranked subset while believing it had the whole database. Checking for a
 *  column the wrong tab cannot have is what turns a renamed tab into a loud failure. */
export const TAB_FINGERPRINT: Record<string, string> = { "all-items": "seen", "ranked-items": "score" };

export async function readTabPublic(tab: string, opts: ReadTabOptions = {}): Promise<SheetRow[]> {
  const impl = opts.fetch ?? fetch;
  const res = await impl(publicCsvUrl(tab, opts.spreadsheet ?? WATCH_SHEET_ID), { redirect: "follow", signal: AbortSignal.timeout(PUBLIC_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`the public read of "${tab}" answered HTTP ${res.status}`);
  const body = await res.text();
  if (!looksLikeCsv(body)) throw new Error(`the public read of "${tab}" returned a sign-in page rather than CSV — the Sheet is no longer readable by link`);
  const rows = parseCsv(body);
  if (rows.length === 0) throw new Error(`the public read of "${tab}" came back empty`);
  const out = toObjects(rows).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, normalizeGvizDate(v)])));
  const fingerprint = TAB_FINGERPRINT[tab];
  if (fingerprint && out[0] && !(fingerprint in out[0])) {
    throw new Error(`the tab "${tab}" came back without its "${fingerprint}" column — gviz serves the first tab for a name it does not know, so "${tab}" has probably been renamed in the Sheet`);
  }
  return out;
}

export async function readTab(tab: string, opts: ReadTabOptions = {}): Promise<SheetRow[]> {
  // No credential is the most reliable credential a launchd job can have. gws stays as the fallback
  // for the day the Sheet stops being link-shared.
  // A caller that substituted the gws seam and gave the public reader nothing to use is testing the
  // credentialed path; attempting the public one would put the real network inside a unit test, which
  // is how a suite starts passing for reasons nobody chose.
  const attemptPublic = !opts.noPublic && !(opts.exec && !opts.fetch);
  let publicFailure: string | null = null;
  if (attemptPublic) {
    try {
      const rows = await readTabPublic(tab, opts);
      opts.log?.(`  "${tab}" read over plain HTTPS, no credential used`);
      return rows;
    } catch (err) {
      // Kept, not swallowed. If the Sheet stops being link-shared AND gws is still broken, a bare
      // "run gws auth logout" sends the user back into defect 13's loop while the actual change was
      // the sharing setting. Both reasons have to reach the log.
      publicFailure = err instanceof Error ? err.message : String(err);
      opts.log?.(`  ! the public read failed (${publicFailure}); falling back to gws`);
    }
  }
  const bin = opts.gws ?? resolveGws();
  const args = ["sheets", "+read", "--spreadsheet", opts.spreadsheet ?? WATCH_SHEET_ID, "--range", opts.range ?? `${tab}!A:Z`, "--format", "csv"];
  let stdout: string;
  try {
    stdout = opts.exec ? await opts.exec(bin, args) : (await run(bin, args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (err) {
    // gws prints its 401 as a JSON object on STDOUT and leaves stderr empty, then exits 1 —
    // verified live 2026-09-24. Scanning only stderr made the one message that names the fix
    // unreachable through the path this actually takes, which is the same defect shape as v7 M1's
    // readHint. Scan everything the failed process said.
    const e = err as { message?: string; stdout?: string; stderr?: string };
    const text = [e.message, e.stdout, e.stderr].filter(Boolean).join(" ") || String(err);
    const also = publicFailure ? ` — and the credential-free read failed first: ${publicFailure}` : "";
    if (/401|credential|auth|decrypt/i.test(text)) throw new Error(`${(await authTrouble(opts)) ?? NOT_AUTHED} (gws said: ${gwsMessage(text)})${also}`);
    throw new Error(`couldn't read the "${tab}" tab with ${bin}: ${text.slice(0, 300)}${also}`);
  }
  // a gws that exits 0 but prints an error object must not be parsed as a one-row CSV
  if (/no credentials provided|auth login|could not decrypt|"reason":\s*"authError"/i.test(stdout)) throw new Error(`${NOT_AUTHED} (gws said: ${gwsMessage(stdout)})`);
  const rows = parseCsv(stdout);
  if (rows.length === 0) throw new Error(`the "${tab}" tab came back completely empty — that is a failed read, not an empty pipeline`);
  return toObjects(rows);
}

export interface Harvest {
  all: WatchItem[];
  /** Only the rows this review has not already put in front of the agents. */
  fresh: WatchItem[];
  /** The fresh rows the pipeline's own ranker ranked — the review's intake. the user's call,
   *  2026-09-25: the review scouts what his ranker ranked, and invents no threshold of its own. */
  eligible: WatchItem[];
  /** Fresh, at or before the ranker's horizon, and still unranked — so the pipeline HAS looked at
   *  them and did not rank them. A decision was made, so the watermark may pass them. */
  unranked: WatchItem[];
  /** Fresh, but newer than anything in ranked-items, so the ranker has not reached them yet. These
   *  must NOT advance the watermark: skipping them is timing, not a decision. */
  notYetRanked: WatchItem[];
  /** The newest FIRST_SEEN in ranked-items — how far the pipeline's own ranker has got. */
  rankedHorizon: string | null;
  newestSeenAt: string | null;
  /** Set when the daily pipeline itself appears to have stopped; carried into the note and Slack. */
  staleWarning: string | null;
  /** The pipeline's own score/rank note, by item id, when `ranked-items` was readable. */
  ranked: Map<string, SheetRow>;
}

/** More than this without a new harvest means the daily job is not running, not that the world
 *  went quiet. Two days covers a single missed run plus slack for timezones. */
export const STALE_AFTER_DAYS = 2;

export function summarise(all: WatchItem[], state: ReviewState, now = new Date()): Omit<Harvest, "all" | "ranked" | "eligible" | "unranked" | "notYetRanked" | "rankedHorizon"> {
  // Two filters, both needed. The date cutoff does the bounding — `all-items` is the pipeline's
  // entire database, so without it every run would scout years of history. The id map catches the
  // rows inside the overlap window that a previous run already considered.
  const reviewed = state.reviewed ?? {};
  const after = cutoffMs(state, now);
  const fresh = all.filter((i) => i.key && !(i.key in reviewed) && (parseWhen(i.seenAt) === 0 || parseWhen(i.seenAt) > after));
  const newest = all.reduce<{ iso: string | null; t: number }>((best, i) => (parseWhen(i.seenAt) > best.t ? { iso: i.seenAt, t: parseWhen(i.seenAt) } : best), { iso: null, t: 0 });
  const ageDays = newest.t ? (now.getTime() - newest.t) / 86_400_000 : Infinity;
  const staleWarning =
    newest.iso === null
      ? `No row in the Sheet carries a readable first-seen date, so the review cannot tell whether the daily pipeline is still running.`
      : ageDays > STALE_AFTER_DAYS
        ? `The watch pipeline has harvested nothing since ${newest.iso} (${Math.floor(ageDays)} days ago). The daily job on the scheduler host has probably stopped — anything below is old news, not a quiet week.`
        : null;
  return { fresh, newestSeenAt: newest.iso, staleWarning };
}

export async function harvest(state: ReviewState, opts: ReadTabOptions = {}, now = new Date()): Promise<Harvest> {
  const all = requireColumns(await readTab("all-items", opts), "all-items");
  // the pipeline's own ranking is useful context but not load-bearing: a review without it is
  // still a review, a review without all-items is not
  // ranked-items is LOAD-BEARING as of 2026-09-25, and no longer merely useful context: it decides
  // the review's intake. all-items is the pipeline's whole database — 5,595 rows against 1,818
  // ranked, so scouting it whole is ~373 sequential model calls that read as a hang. Its absence
  // must therefore be loud: falling through with an empty map would scout nothing and report a
  // clean, confident "0 new".
  let ranked: Map<string, SheetRow>;
  try {
    // ranked-items has no id column either; its identity is the URL, same as all-items
    ranked = new Map(
      (await readTab("ranked-items", opts))
        .filter((r) => (r.url ?? "").trim())
        .map((r) => [r.url!.trim(), r] as const),
    );
  } catch (err) {
    throw new Error(`the "ranked-items" tab is unreadable, and the review keys its intake on it — it cannot tell which rows the pipeline judged worth ranking, and scouting all ${all.length} harvest rows instead would be hours of model calls. ${err instanceof Error ? err.message : String(err)}`);
  }
  if (ranked.size === 0) throw new Error(`the "ranked-items" tab parsed but held no rows with a URL — that is a failed read, not an unranked week`);
  const base = summarise(all, state, now);
  // all-items carries the same URL more than once (5,595 rows, 5,225 distinct URLs live), so without
  // this the Scout is handed the same page twice and asked about it twice. Safe to drop here because
  // identity everywhere downstream is the URL: the watermark's `reviewed` map is keyed on it, and
  // `unconsidered` is computed by key, so the copy is covered by the row that was actually answered.
  const seen = new Set<string>();
  const eligible = base.fresh.filter((i) => ranked.has(i.key) && !seen.has(i.key) && (seen.add(i.key), true));

  // "Unranked" and "not ranked YET" are different facts with opposite consequences for the
  // watermark, and telling them apart is the difference between skipping a row on purpose and
  // losing it. The ranker's horizon is the newest row ranked-items holds: at or before it, the
  // pipeline saw the row and passed on it; after it, the pipeline simply has not got there.
  //
  // This is not hypothetical. all-items and ranked-items are two separate HTTP reads of a Sheet the
  // pipeline rewrites at 13:00 UTC, and 09:00 America/New_York IS 13:00 UTC — so the scheduled run
  // reads it at the exact minute it is being rewritten. Observed 2026-09-25: both tabs' newest
  // FIRST_SEEN were identical to the second (2026-09-24T13:05:06), which is what a same-sync write
  // looks like — and therefore exactly the pair a mid-rewrite read can catch out of step.
  const horizonMs = [...ranked.values()].reduce((best, r) => Math.max(best, parseWhen(r.firstseen ?? r.fetched ?? "")), 0);
  const rankedHorizon = horizonMs ? new Date(horizonMs).toISOString() : null;
  const rest = base.fresh.filter((i) => !ranked.has(i.key));
  const notYetRanked = horizonMs ? rest.filter((i) => parseWhen(i.seenAt) > horizonMs) : rest;
  const behind = new Set(notYetRanked);
  const unranked = rest.filter((i) => !behind.has(i));

  // A ranker that has died while the harvest keeps running would otherwise read as policy: the note
  // would say "0 scouted, N not scouted" and look like a deliberate screen.
  const newestMs = parseWhen(base.newestSeenAt ?? "");
  const lagDays = horizonMs && newestMs ? (newestMs - horizonMs) / 86_400_000 : 0;
  const rankerWarning =
    horizonMs === 0
      ? `No row in ranked-items carries a readable date, so the review cannot tell how far the pipeline's ranker has got.`
      : lagDays > STALE_AFTER_DAYS
        ? `The watch pipeline is still harvesting (newest ${base.newestSeenAt}) but has ranked nothing since ${rankedHorizon} (${Math.floor(lagDays)} days behind). Its ranker has probably stopped — this review takes its intake from ranked-items, so it is reviewing almost nothing, and that is a broken pipeline rather than a quiet week.`
        : null;
  const staleWarning = [base.staleWarning, rankerWarning].filter(Boolean).join(" ") || null;

  return { all, ranked, ...base, staleWarning, eligible, unranked, notYetRanked, rankedHorizon };
}
