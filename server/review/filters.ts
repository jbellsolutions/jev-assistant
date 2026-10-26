/** the user's standing rules, so they are applied in code and never left to
 *  a model's judgement — a model can be argued round, a filter cannot.
 *
 *  1. PAID ENRICHMENT ANSWER-DATABASES are out, absolutely. The premise of an agent with tools is
 *     that it does the enrichment itself via a browser; renting the answer misses the entire point.
 *     (Confirmed absolute 2026-05-25 after two advisors suggested softening it.)
 *  2. AN AUTONOMOUS AGENT THAT OWNS THE TASK LOOP is not adopted as-is. This is v7's load-bearing
 *     line: Jev owns the loop and the model only answers bounded questions. Such a candidate is not
 *     rejected outright — it can be excellent *as an engine behind the seam* — so it is flagged,
 *     and the Arbiter may only recommend it in that shape.
 *  3. MEMORY IS THE OBSIDIAN VAULT. the user's rule is absolute in the same way: the memory substrate
 *     IS an Obsidian vault of daily and linked notes, and semantic search (mem0 or equivalent) is
 *     layered ON TOP of those files, never as a replacement — "if the user can't open
 *     obsidian://open?vault=… and see what the agent remembers, the memory layer isn't done."
 *     Added 2026-09-25 because a live review put a SQLite-backed long-term memory store at the TOP
 *     of its recommendations, as a *pilot*, with nothing in the filters to notice. Like
 *     loop-ownership this is a flag rather than a rejection: such a tool is welcome as the search
 *     layer over the vault, and unwelcome as the place the memories actually live.
 *
 *  Plumbing is not renting an answer: a SERP API, an unlocker, a proxy or a hosted browser is a
 *  tool the agent drives, and stays eligible. That distinction is the whole reason this is a
 *  hand-written list rather than a "does it cost money" test. */
export interface FilterVerdict {
  /** "reject" is final; "flag" narrows what the Arbiter may recommend. */
  kind: "reject" | "flag";
  reason: string;
}

/** Vendors whose product IS the answer set. Names only — the matcher supplies the word boundaries. */
export const PAID_ENRICHMENT = ["clay.com", "clay run", "apollo.io", "hunter.io", "ocean.io", "zoominfo", "lusha", "cognism", "rocketreach", "seamless.ai", "clearbit", "people data labs", "snov.io", "findymail", "dropcontact"] as const;

/** Names that need a second signal, because the bare word is also something innocent — Apollo is a
 *  GraphQL client, Clay is a UI toolkit. Matching those would reject good candidates silently. */
const AMBIGUOUS: Record<string, RegExp> = {
  apollo: /\b(lead|leads|prospect|contact|enrich|b2b|sales|email finder|outbound)\b/i,
  clay: /\b(lead|leads|prospect|contact|enrich|b2b|sales|outbound|gtm)\b/i,
  hunter: /\b(email|lead|leads|prospect|contact|enrich|verif)\b/i,
};

/** Dataset products that are pre-scraped records rather than plumbing. */
export const PRESCRAPED = ["bright data dataset", "brightdata dataset", "dataset extractor", "apify actor for linkedin", "phantombuster"] as const;

/** Phrases that describe a system taking the wheel, rather than a driver a caller steers. */
export const LOOP_OWNING = ["autonomous agent", "agentic loop", "runs the whole task", "end-to-end agent", "self-directed agent", "agent mode", "gives the agent a goal", "fully autonomous", "does the task for you"] as const;

/** The phrase list alone is not enough, and a live run proved it: browser-use's own README says
 *  "it owns its own agent loop", which none of the phrases above catch — while Steel's says "does
 *  not own the agent loop, which you build on top", which a naive substring would wrongly flag.
 *  `\bowns\b` separates the two: the negation is written with "own", the claim with "owns". */
/** Candidates whose product is the place memories LIVE, rather than a way to search the vault.
 *
 *  Written against the text the filter ACTUALLY receives — a row's title and the Sheet's own summary
 *  — and not against the prose a later agent writes about it. The first draft of this rule was a
 *  phrase list checked against the Surveyor's description, and it would have sailed straight past the
 *  candidate that motivated it: `kitfunso/hippo-memory`, whose real summary reads "Biologically-
 *  inspired memory for AI agents. Decay, retrieval strengthening, consolidation. Zero runtime deps,
 *  SQLite, MCP." Not one of "long-term memory", "memory store" or "agent memory" appears in it. */
export const MEMORY_SUBSTRATE: RegExp[] = [
  /\bmemory\s+(?:system|store|layer|backend|database|bank|engine)\b/i,
  /\b(?:long[- ]term|persistent|episodic|semantic|agentic)\s+memory\b/i,
  /\bmemory\s+(?:for|layer for)\s+(?:ai\s+|llm\s+)?agents?\b/i,
  /\bagent(?:ic)?\s+memory\b/i,
  /\bremembers?\s+across\s+(?:runs|sessions|conversations)\b/i,
];

/** A storage backend named beside "memory" is the tell that it wants to BE the substrate. */
const MEMORY_BACKEND = /\b(?:sqlite|postgres(?:ql)?|duckdb|redis|lancedb|chroma|qdrant|weaviate|pinecone|vector\s+(?:db|database|store)|knowledge\s+base)\b/i;

export const LOOP_OWNING_PATTERNS: RegExp[] = [
  /\bowns?\s+(?:its|the|their)\s+own\s+(?:agent\s+)?loop\b/i,
  /\bowns\b[^.]{0,40}\bagent(?:ic)?\s+loop\b/i,
  /\b(?:plans?|decides?)\s+and\s+(?:executes?|acts?)\b[^.]{0,40}\b(?:itself|on its own|end to end)\b/i,
];

const hasWord = (haystack: string, needle: string): boolean => new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(haystack);

/** `text` is everything known about the candidate: its title, summary, and whatever Jev read off
 *  the page. Reading the page matters here — a vendor's own site says what it sells far more
 *  plainly than a Hacker News headline does. */
export function screen(text: string): FilterVerdict | null {
  const t = text.toLowerCase();

  for (const name of PAID_ENRICHMENT) if (hasWord(t, name)) return { kind: "reject", reason: `${name} is a paid enrichment answer-database. Standing rule: Jev does its own enrichment with a browser; renting the answer is out, absolutely.` };
  for (const name of PRESCRAPED) if (t.includes(name)) return { kind: "reject", reason: `${name} sells pre-scraped records rather than plumbing. Standing rule: SERP, unlockers and proxies are fine; answer-databases are not.` };

  for (const [name, corroborate] of Object.entries(AMBIGUOUS)) {
    if (hasWord(t, name) && corroborate.test(t)) return { kind: "reject", reason: `"${name}" here is the lead-enrichment product, not the developer library of the same name. Standing rule: no paid enrichment services.` };
  }

  const flag = (quote: string): FilterVerdict => ({ kind: "flag", reason: `This describes itself as "${quote}" — it wants to own the task loop. v7's line is that Jev owns the loop and the model only answers bounded questions, so it may only be recommended as an engine behind the executor seam, never as the thing in charge.` });
  for (const phrase of LOOP_OWNING) if (t.includes(phrase)) return flag(phrase);
  for (const re of LOOP_OWNING_PATTERNS) {
    const m = re.exec(text);
    if (m) return flag(m[0].trim());
  }

  // Checked after loop-ownership, which is the more fundamental objection when a candidate is both.
  // Something that already sits on the vault is the shape the user asked for, not a replacement.
  const onTheVault = /\bobsidian\b|\bmarkdown\s+(?:vault|notes|files)\b/i.test(t);
  if (!onTheVault) {
    const hit = MEMORY_SUBSTRATE.map((re) => re.exec(text)).find(Boolean) ?? (/\bmemory\b/i.test(t) && MEMORY_BACKEND.test(t) ? /\bmemory\b/i.exec(text) : null);
    if (hit) {
      return {
        kind: "flag",
        reason: `This describes itself around "${hit[0].trim()}" — it wants to be the place memories live. Standing rule: the memory substrate IS the user's Obsidian vault (daily and linked notes), and semantic search is layered ON TOP of those files, never as a replacement. It may only be recommended as the search or retrieval layer over the vault — if he cannot open obsidian://open?vault=… and read what the agent remembers, it is not done.`,
      };
    }
  }
  return null;
}

/** Same screen, over an item's own fields plus whatever the investigation pass read. */
export function screenItem(parts: Array<string | null | undefined>): FilterVerdict | null {
  return screen(parts.filter(Boolean).join(" \n "));
}
