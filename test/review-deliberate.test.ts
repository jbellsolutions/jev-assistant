import { describe, expect, it } from "vitest";
import type { OneShot } from "../server/brain/oneshot.js";
import type { Arbiter } from "../server/review/arbiter.js";
import { type Candidate, contested, deliberate, parseProposals, SCOUT_CONCURRENCY, scout } from "../server/review/deliberate.js";
import { screen } from "../server/review/filters.js";
import type { Finding } from "../server/review/investigate.js";
import type { Manifest } from "../server/review/manifest.js";
import type { WatchItem } from "../server/review/sheet.js";

const item = (id: string, title: string, summary = ""): WatchItem => ({ key: `https://example.com/${id}`, title, url: `https://example.com/${id}`, seenAt: "2026-09-23", summary });

const MANIFEST: Manifest = {
  generated: "2026-09-23T00:00:00.000Z",
  repo: "/repo",
  actions: ["navigate", "click", "type"],
  executorKinds: ["playwright", "chrome", "mac", "orgo"],
  executors: [{ file: "server/executors/playwright.ts", id: "playwright", kind: "playwright", capabilities: { read: true } }],
  planned: ["orgo"],
  routes: [{ id: "browser_now", what: "one obvious action" }],
  brainTools: ["mac_read", "chrome", "browser_box"],
  brainModel: "z-ai/glm-5.3-flash",
  connectors: { reads: ["SLACK_FETCH_CONVERSATION_HISTORY"], writes: ["SLACK_SEND_MESSAGE"] },
  browserBox: ["fetch", "read"],
  macDriver: ["get_window_state", "click"],
  httpRoutes: ["GET /api/health"],
  limits: { brain: { maxSteps: 20 } },
  live: null,
};

/** A OneShot stand-in that answers by which system prompt it was handed. */
function fakeOneShot(answers: { scout?: unknown; survey?: (user: string) => unknown; rebuttal?: unknown }, log: string[] = []) {
  return {
    async json(system: string, user: string) {
      if (system.includes("triage a research feed")) {
        log.push("scout");
        if (answers.scout instanceof Error) throw answers.scout;
        return answers.scout;
      }
      if (system.includes("compare one candidate")) {
        log.push("survey");
        return answers.survey?.(user) ?? { id: /id=(\S+)/.exec(user)?.[1] ?? "?", verdict: "gap", nearest: "nothing comparable", gap: "new" };
      }
      log.push("rebuttal");
      if (answers.rebuttal instanceof Error) throw answers.rebuttal;
      return answers.rebuttal ?? { replies: [] };
    },
    clip: (t: string) => t,
  } as unknown as OneShot;
}

function fakeArbiter(rounds: unknown[], log: string[] = []) {
  let n = 0;
  return {
    async json() {
      log.push(`arbiter${n + 1}`);
      const next = rounds[Math.min(n++, rounds.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as Arbiter;
}

const scoutCall = (id: string, shortlist = true) => ({ id: `https://example.com/${id}`, category: "browser-use" as const, claim: `what ${id} is`, whyItMightMatter: "it might help", shortlist });
const proposal = (id: string, decision: "adopt" | "pilot" | "watch" | "reject", why = "because") => ({ id: `https://example.com/${id}`, decision, value: "medium" as const, effort: "medium" as const, risk: "low" as const, why });

describe("memory is the Obsidian vault", () => {
  // Added after a live review put a SQLite-backed long-term memory store at the TOP of its
  // recommendations — as a pilot — with nothing in the filters to notice. the user's rule is absolute:
  // the vault holds the memories, semantic search goes on top, never instead.
  // The REAL text the filter receives — this row's title and the Sheet's own summary, verbatim from
  // ranked-items. The first draft of this rule was tested against the Surveyor's prose instead, which
  // screen() never sees, and would have sailed straight past the case that motivated it.
  const hippo = "kitfunso/hippo-memory Biologically-inspired memory for AI agents. Decay, retrieval strengthening, consolidation. Zero runtime deps, SQLite, MCP. Benchmarked retrieval with an opt-in TypeSafe Jev reranker.";

  it("flags a candidate that wants to be the place memories live", () => {
    const v = screen(hippo);
    expect(v?.kind).toBe("flag");
    expect(v?.reason).toMatch(/memory substrate IS the user's Obsidian vault/);
  });

  it("does not flag one that searches the vault rather than replacing it", () => {
    expect(screen("semantic search over your Obsidian markdown vault, adding long-term memory recall on top of the notes you already keep")).toBeNull();
  });

  it("prefers the loop-ownership objection when a candidate is both", () => {
    const v = screen("a fully autonomous agent with its own long-term memory store");
    expect(v?.reason).toMatch(/own the task loop/);
  });

  it("does not flag ordinary uses of the word memory", () => {
    expect(screen("runs in 0.74 GB RAM with a small memory footprint")).toBeNull();
  });
});

describe("one bad Scout answer", () => {
  const rows = Array.from({ length: 15 }, (_, n) => ({ key: `k${n}`, url: `u${n}`, title: `t${n}`, seenAt: "2026-09-23T00:00:00" }) as WatchItem);
  const good = (n: number) => ({ id: `k${n}`, category: "browser-use", claim: "c", whyItMightMatter: "w", shortlist: false });

  it("costs that row, not the fourteen beside it", async () => {
    // v8 learned this on the Arbiter — real Hermes answered "high (fills a real gap)" for one item's
    // value and a strict enum threw away three sound judgements with it — and the Scout kept the old
    // shape. Here it is worse: a strict array means one bad item fails the parse, burns OneShot's
    // stricter retry, and then loses all fifteen rows. An answer with no id cannot be attached to a
    // row, so it is the one thing normalising cannot save.
    const answer = { items: [...Array.from({ length: 14 }, (_, n) => good(n)), { category: "browser-use", claim: "c", whyItMightMatter: "w", shortlist: false }] };
    // The fake must APPLY the schema, exactly as OneShot.json does — validate, retry once, then throw.
    // A fake that just hands the object back tests the loop and not the contract, and would pass
    // against the strict-array shape this test exists to rule out.
    const oneshot = {
      json: async (_system: string, _user: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }) => {
        const parsed = schema.safeParse(answer);
        if (!parsed.success) throw new Error("the Scout's answer didn't fit the shape asked for");
        return parsed.data;
      },
    } as unknown as OneShot;
    const problems: string[] = [];
    const out = await scout(oneshot, rows, 15, problems);
    expect(out).toHaveLength(14);
    expect(problems.join(" ")).toMatch(/gave no usable answer for 1 of the 15 rows 1–15; those rows are held/);
  });

  it("recovers an answer that is merely shaped oddly, rather than binning the row", async () => {
    // A live run lost three near-whole batches (15 of 15, 15 of 15, 14 of 15) to per-item validation
    // while a direct probe of the same prompt came back perfectly shaped — so some responses differ
    // and it is not reproducible on demand. Normalising first turns those into usable answers.
    const odd = [
      { url: "k0", kind: "browser-use", what: "it does a thing", why: "it fills a gap", short_list: "true" },
      { id: "k1", category: "browser-use", claim: "c", why_it_might_matter: "w", shortlist: 1 },
      { id: "k2", category: "browser-use", claim: "", whyItMightMatter: "", shortlist: false },
    ];
    const oneshot = { json: async () => ({ items: odd }) } as unknown as OneShot;
    const out = await scout(oneshot, rows, 15, []);
    expect(out.map((c) => c.id)).toEqual(["k0", "k1", "k2"]);
    expect(out[0]).toMatchObject({ claim: "it does a thing", whyItMightMatter: "it fills a gap", shortlist: true });
    expect(out[1]?.shortlist).toBe(true);
    // a missing rationale is worth keeping as a thin answer; it is not worth losing the row over
    expect(out[2]).toMatchObject({ claim: "no claim given", whyItMightMatter: "no reason given" });
  });

  it("never invents a verdict for a row the model did not judge", async () => {
    // Defaulting shortlist to false would mark an unjudged row "not worth doing", let it into
    // `considered`, and move the watermark past it — silently REJECTING the row rather than holding
    // it, which is the precise failure normalisation exists to avoid.
    const oneshot = {
      json: async () => ({
        items: [
          { id: "k0", category: "browser-use", claim: "c", whyItMightMatter: "w" }, // no verdict at all
          { id: "k1", category: "browser-use", claim: "c", whyItMightMatter: "w", shortlist: "maybe" }, // not a verdict
          good(2),
        ],
      }),
    } as unknown as OneShot;
    const problems: string[] = [];
    const out = await scout(oneshot, rows, 15, problems);
    expect(out.map((c) => c.id)).toEqual(["k2"]);
    expect(problems.join(" ")).toMatch(/gave no usable answer for 14 of the 15 rows/);
  });

  it("counts rows the Scout simply left out, not just the ones it got wrong", async () => {
    // The common case live: ~16% of rows come back with no answer at all, and nothing is malformed.
    // Counting against the answers RETURNED would report zero problems and look perfectly healthy
    // while a sixth of every batch quietly goes unreviewed.
    const oneshot = { json: async () => ({ items: Array.from({ length: 10 }, (_, n) => good(n)) }) } as unknown as OneShot;
    const problems: string[] = [];
    const out = await scout(oneshot, rows, 15, problems);
    expect(out).toHaveLength(10);
    expect(problems.join(" ")).toMatch(/gave no usable answer for 5 of the 15 rows/);
  });

  it("still ignores an answer about a row that was not in the batch", async () => {
    const oneshot = { json: async () => ({ items: [good(0), { ...good(0), id: "not-in-this-batch" }] }) } as unknown as OneShot;
    const out = await scout(oneshot, rows, 15, []);
    expect(out.map((c) => c.id)).toEqual(["k0"]);
  });
});

describe("the Scout's wall-clock budget", () => {
  const oneshot = { json: async () => ({ items: [] }) } as unknown as OneShot;
  const items = Array.from({ length: 45 }, (_, n) => ({ key: `k${n}`, url: `u${n}`, title: `t${n}`, seenAt: "2026-09-23T00:00:00" }) as WatchItem);

  it("stops scouting when the budget is spent and says how much it did not look at", async () => {
    // Each call may sit on OneShot's 4-minute timeout, so 136 batches is a nine-hour worst case with
    // nothing structural to stop it — against this design's own rule that a review cannot run away.
    const problems: string[] = [];
    let t = 0;
    await scout(oneshot, items, 15, problems, undefined, 1_000, () => (t += 600));
    expect(problems.join(" ")).toMatch(/ran out of its 0-minute budget after 1 of 3 batches; the remaining 30 row\(s\) were not looked at and are held/);
  });

  it("runs batches concurrently, because the Scout pass is generation-bound", async () => {
    // Measured live 2026-09-25: one 15-row batch is 9.5s and 1,114 completion tokens. Sequentially a
    // first run is ~21 minutes — it sat exactly on the 20-minute budget, which would have meant
    // deferring rows every run and never catching up.
    let inFlight = 0;
    let peak = 0;
    const slow = {
      json: async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { items: [] };
      },
    } as unknown as OneShot;
    // no concurrency argument: this asserts the shipped default, not a number the test chose
    await scout(slow, items, 5, [], undefined, 60_000, () => 0);
    expect(peak).toBe(SCOUT_CONCURRENCY);
    expect(SCOUT_CONCURRENCY).toBeGreaterThan(1);
  });

  it("still finishes every batch when told to run one at a time", async () => {
    let calls = 0;
    const counting = { json: async () => (calls++, { items: [] }) } as unknown as OneShot;
    const problems: string[] = [];
    await scout(counting, items, 15, problems, undefined, 60_000, () => 0, 1);
    expect(calls).toBe(3);
    expect(problems.filter((p) => p.includes("budget"))).toEqual([]);
  });

  it("does not bite on a run that finishes inside the budget", async () => {
    const problems: string[] = [];
    await scout(oneshot, items, 15, problems, undefined, 60_000, () => 0);
    // asserts the BUDGET did not bite — the fake answers nothing, so the "no usable answer" notes
    // are expected and are a different guarantee
    expect(problems.filter((p) => p.includes("budget"))).toEqual([]);
  });
});

describe("standing-rule filters (code, not judgement)", () => {
  it("rejects paid enrichment answer-databases by name", () => {
    expect(screen("ZoomInfo now exposes an MCP server")?.kind).toBe("reject");
    expect(screen("a guide to hunter.io for finding emails")?.reason).toMatch(/answer-database/);
  });

  it("does not reject the developer libraries that share those names", () => {
    // Apollo is a GraphQL client and Clay is a UI toolkit — rejecting those would silently drop
    // good candidates, which is exactly the failure this list is written carefully to avoid
    expect(screen("Apollo Client 4 adds a new normalized cache for React")).toBeNull();
    expect(screen("Clay, a Rust UI layout library, hits 1.0")).toBeNull();
    // ...but the lead-gen product of the same name is still caught
    expect(screen("Apollo.io adds bulk contact enrichment for B2B sales teams")?.kind).toBe("reject");
  });

  it("flags rather than rejects something that wants to own the loop", () => {
    const v = screen("an autonomous agent that plans and executes browser tasks end to end");
    expect(v?.kind).toBe("flag");
    expect(v?.reason).toMatch(/engine behind the executor seam/);
  });

  it("reads real pages Jev fetched, including the negation trap", () => {
    // Both strings are verbatim from a live investigation run on 2026-09-24. browser-use's page
    // says it owns the loop in words no phrase list caught; Steel's says it does NOT, in words a
    // naive substring match would have flagged. Pinned so neither can regress.
    const browserUse = "Open-source browser agent that navigates the web like a human; the MIT-licensed Python library is free but requires an LLM API key with paid cloud options; it owns its own agent loop in the Python library and fully hosted Cloud, though the CLI mode just gives browser control to external agents.";
    const steel = "An open-source browser API/sandbox (session management, proxies, scraping, screenshots, PDFs) for building AI agents and automation; runs self-hosted via Docker or Node.js with Chrome — no paid account, API key, or login required; it provides browser infrastructure only and does not own the agent loop, which you build on top via Puppeteer/Playwright/Selenium.";
    expect(screen(browserUse)).toMatchObject({ kind: "flag" });
    expect(screen(browserUse)?.reason).toMatch(/owns its own agent loop/);
    expect(screen(steel)).toBeNull();
  });

  it("leaves plumbing alone", () => {
    expect(screen("a SERP API and residential proxy network for scraping search results")).toBeNull();
    expect(screen("Steel: an open-source headless browser API you drive yourself")).toBeNull();
  });
});

describe("what gets challenged", () => {
  const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({ item: item(id, id), scout: scoutCall(id), survey: null, finding: null, ranked: null, filtered: null, ...over });

  it("challenges the Arbiter when the Scout was keen and it said no", () => {
    expect(contested([cand("a")], [proposal("a", "reject")]).map((p) => p.id)).toEqual(["https://example.com/a"]);
    expect(contested([cand("a")], [proposal("a", "adopt")])).toEqual([]);
  });

  it("challenges the Arbiter when it wants something the Surveyor says we already have", () => {
    const c = cand("a", { survey: { id: "https://example.com/a", verdict: "have", nearest: "server/executors/playwright.ts", gap: "redundant" } });
    expect(contested([c], [proposal("a", "adopt")]).map((p) => p.id)).toEqual(["https://example.com/a"]);
  });

  it("never reopens something a standing rule decided", () => {
    const c = cand("a", { filtered: { kind: "reject", reason: "paid enrichment" } });
    expect(contested([c], [proposal("a", "reject")])).toEqual([]);
  });
});

describe("the deliberation", () => {
  const ranked = new Map();
  const noFindings: Finding[] = [];

  it("runs all three rounds and keeps the dissent", async () => {
    const log: string[] = [];
    const oneshot = fakeOneShot({ scout: { items: [scoutCall("a")] }, rebuttal: { replies: [{ id: "https://example.com/a", stance: "defend", argument: "it does something playwright cannot" }] } }, log);
    const arbiter = fakeArbiter([{ items: [proposal("a", "reject", "looks redundant")] }, { items: [proposal("a", "pilot", "the Scout is right, one bounded test would settle it")] }], log);

    const r = await deliberate([item("a", "Some browser engine")], ranked, { oneshot, arbiter, manifest: MANIFEST });

    expect(log).toEqual(["scout", "survey", "arbiter1", "rebuttal", "arbiter2"]);
    expect(r.decisions[0]).toMatchObject({ id: "https://example.com/a", decision: "pilot", byRule: false });
    // the disagreement is the most valuable part of the review and must survive into the note
    expect(r.decisions[0]?.rebuttal).toMatchObject({ stance: "defend" });
    expect(r.problems).toEqual([]);
  });

  it("skips the rebuttal round when nobody disagrees", async () => {
    const log: string[] = [];
    const oneshot = fakeOneShot({ scout: { items: [scoutCall("a")] } }, log);
    const arbiter = fakeArbiter([{ items: [proposal("a", "adopt")] }], log);
    await deliberate([item("a", "x")], ranked, { oneshot, arbiter, manifest: MANIFEST });
    expect(log).toEqual(["scout", "survey", "arbiter1"]);
  });

  it("lets a standing rule overrule the Arbiter, and says it was the rule", async () => {
    const oneshot = fakeOneShot({ scout: { items: [scoutCall("a")] } });
    const arbiter = fakeArbiter([{ items: [proposal("a", "adopt", "this would save hours")] }]);
    const r = await deliberate([item("a", "ZoomInfo MCP server", "bulk contact enrichment")], ranked, { oneshot, arbiter, manifest: MANIFEST });
    expect(r.decisions[0]).toMatchObject({ decision: "reject", byRule: true });
    expect(r.decisions[0]?.why).toMatch(/answer-database/);
  });

  it("screens what Jev read on the page, not just the headline", async () => {
    const oneshot = fakeOneShot({ scout: { items: [scoutCall("a")] } });
    const arbiter = fakeArbiter([{ items: [proposal("a", "adopt")] }]);
    // an innocuous title; the vendor's own page is where it says what it sells
    const findings: Finding[] = [{ id: "https://example.com/a", url: "https://example.com/a", status: "ok", answer: "a B2B lead enrichment platform — this is apollo.io", error: null }];
    const r = await deliberate([item("a", "New GTM tooling roundup")], ranked, { oneshot, arbiter, manifest: MANIFEST, investigate: async () => ({ findings, note: null }) });
    expect(r.decisions[0]).toMatchObject({ decision: "reject", byRule: true });
  });

  it("still applies the rules when the Arbiter is unreachable, and records why", async () => {
    const oneshot = fakeOneShot({ scout: { items: [scoutCall("a"), scoutCall("b")] } });
    const arbiter = fakeArbiter([new Error("Hermes refused the run (HTTP 401)")]);
    const r = await deliberate([item("a", "Clearbit enrichment API"), item("b", "Some browser engine")], ranked, { oneshot, arbiter, manifest: MANIFEST });
    expect(r.problems[0]).toMatch(/Arbiter could not propose.*401/);
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0]).toMatchObject({ id: "https://example.com/a", decision: "reject", byRule: true });
  });

  it("loses only the rows a failed Scout batch covered, and writes that down", async () => {
    const oneshot = fakeOneShot({ scout: new Error("the model's answer didn't fit the shape asked for") });
    const arbiter = fakeArbiter([{ items: [] }]);
    const r = await deliberate([item("a", "x")], ranked, { oneshot, arbiter, manifest: MANIFEST });
    expect(r.problems[0]).toMatch(/Scout could not read rows 1–1/);
    expect(r.decisions).toEqual([]);
  });

  it("keeps the good judgements when the Arbiter answers badly about one item", async () => {
    // Live 2026-09-24: real Hermes answered "high (fills a real gap)" for one item's value and a
    // strict enum threw away the whole round, including three sound judgements. A bad answer must
    // cost that candidate, not the round — the same rule the task loop follows for a failed row.
    const oneshot = fakeOneShot({ scout: { items: [scoutCall("a"), scoutCall("b")] } });
    const arbiter = fakeArbiter([{ items: [{ ...proposal("a", "adopt"), value: "high (fills a real gap)" }, { id: "https://example.com/b", decision: "maybe?", why: "" }] }]);
    const r = await deliberate([item("a", "x"), item("b", "y")], ranked, { oneshot, arbiter, manifest: MANIFEST });
    expect(r.decisions.map((d) => d.id)).toEqual(["https://example.com/a"]);
    expect(r.decisions[0]).toMatchObject({ value: "high" });
    expect(r.problems[0]).toMatch(/unusable for https:\/\/example\.com\/b \(decision, value, effort, risk, why\)/);
  });

  it("normalises the ways a model writes an ordinal", () => {
    const p = (over: Record<string, unknown>) => parseProposals([{ id: "a", decision: "adopt", why: "w", value: "high", effort: "medium", risk: "low", ...over }]).ok[0];
    expect(p({ value: "High" })?.value).toBe("high");
    expect(p({ effort: "moderate" })?.effort).toBe("medium");
    expect(p({ risk: "low — nothing to undo" })?.risk).toBe("low");
    expect(p({ value: 5 })?.value).toBe("high");
    expect(parseProposals([{ id: "a", decision: "adopt", why: "w", value: "banana", effort: "low", risk: "low" }]).bad[0]).toMatch(/^a \(value\)/);
  });

  it("falls back to the standing rules when nothing in the answer is readable", async () => {
    const oneshot = fakeOneShot({ scout: { items: [scoutCall("a")] } });
    const arbiter = fakeArbiter([{ items: [{ nonsense: true }] }]);
    const r = await deliberate([item("a", "Clearbit enrichment API")], ranked, { oneshot, arbiter, manifest: MANIFEST });
    expect(r.problems.some((x) => /nothing in the Arbiter's answer could be read/.test(x))).toBe(true);
    expect(r.decisions[0]).toMatchObject({ decision: "reject", byRule: true });
  });

  it("ignores ids the Scout invented", async () => {
    const oneshot = fakeOneShot({ scout: { items: [scoutCall("a"), scoutCall("ghost")] } });
    const arbiter = fakeArbiter([{ items: [proposal("a", "watch"), proposal("ghost", "adopt")] }]);
    const r = await deliberate([item("a", "x")], ranked, { oneshot, arbiter, manifest: MANIFEST });
    expect(r.decisions.map((d) => d.id)).toEqual(["https://example.com/a"]);
  });
});
