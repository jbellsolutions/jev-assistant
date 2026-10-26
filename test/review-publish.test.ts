import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Decision, DeliberationResult } from "../server/review/deliberate.js";
import type { Finding } from "../server/review/investigate.js";
import type { Manifest } from "../server/review/manifest.js";
import { REVIEW_FOLDER, type PublishInput, postSlack, renderNote, renderSlack, writeNote } from "../server/review/publish.js";
import type { Harvest, WatchItem } from "../server/review/sheet.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const vault = () => {
  const d = mkdtempSync(path.join(tmpdir(), "jev-vault-"));
  dirs.push(d);
  return d;
};

const item = (id: string, title: string): WatchItem => ({ key: `https://example.com/${id}`, title, url: `https://example.com/${id}`, seenAt: "2026-09-23" });
const MANIFEST: Manifest = {
  generated: "2026-09-23T00:00:00.000Z",
  repo: "/repo",
  actions: ["navigate"],
  executorKinds: ["playwright", "orgo"],
  executors: [{ file: "server/executors/playwright.ts", id: "playwright", kind: "playwright", capabilities: { read: true } }],
  planned: ["orgo"],
  routes: [{ id: "browser_now", what: "x" }],
  brainTools: ["mac_read", "chrome", "browser_box"],
  brainModel: "z-ai/glm-5.3-flash",
  connectors: { reads: ["SLACK_FETCH_CONVERSATION_HISTORY"], writes: ["SLACK_SEND_MESSAGE"] },
  browserBox: ["fetch", "read"],
  macDriver: ["get_window_state", "click"],
  httpRoutes: ["GET /api/health"],
  limits: {},
  live: null,
};

function input(over: { decisions?: Decision[]; shortlist?: DeliberationResult["shortlist"]; problems?: string[]; harvest?: Partial<Harvest>; findings?: Finding[]; investigationNote?: string | null } = {}): PublishInput {
  const it = item("a", "Steel: an open-source browser API");
  const shortlist = over.shortlist ?? [{ item: it, scout: { id: it.key, category: "browser-use" as const, claim: "a headless browser API", whyItMightMatter: "it could host Jev's background browser", shortlist: true }, survey: { id: it.key, verdict: "gap" as const, nearest: "server/executors/playwright.ts", gap: "concurrency Jev cannot do locally" }, finding: null, ranked: null, filtered: null }];
  return {
    result: { categorised: [], shortlist, decisions: over.decisions ?? [], problems: over.problems ?? [], findings: over.findings ?? [], investigationNote: over.investigationNote ?? null, considered: [], unconsidered: [], overflow: [] },
    harvest: { all: [it], fresh: [it], eligible: [it], unranked: [], notYetRanked: [], rankedHorizon: "2026-09-23", newestSeenAt: "2026-09-23", staleWarning: null, ranked: new Map(), ...over.harvest } as Harvest,
    manifest: MANIFEST,
    findings: over.findings ?? [],
    investigationNote: over.investigationNote ?? null,
    date: new Date("2026-09-28T13:00:00Z"),
  };
}

const decision = (over: Partial<Decision> = {}): Decision => ({ id: "https://example.com/a", decision: "adopt", value: "high", effort: "medium", risk: "low", why: "it fills a real gap", byRule: false, ...over });

describe("the review note", () => {
  it("leads with what it could not see, not a footnote", () => {
    const md = renderNote(input({ problems: ["the Surveyor could not judge \"X\""], harvest: { staleWarning: "The watch pipeline has harvested nothing since 2026-09-15 (13 days ago)." }, findings: [{ id: "https://example.com/a", url: "u", status: "not-investigated", answer: null, error: "Jev wasn't running" }], decisions: [decision()] }));
    const warnIdx = md.indexOf("## What this review could not see");
    expect(warnIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeLessThan(md.indexOf("## Decisions"));
    expect(md).toMatch(/harvested nothing since 2026-09-15/);
    expect(md).toMatch(/1 of 1 shortlisted pages were not opened/);
    expect(md).toMatch(/^complete: false$/m);
  });

  it("says it is complete only when nothing went wrong", () => {
    expect(renderNote(input({ decisions: [decision()] }))).toMatch(/^complete: true$/m);
  });

  it("reproduces the disagreement in full rather than summarising it", () => {
    const md = renderNote(input({ decisions: [decision({ decision: "pilot", rebuttal: { id: "a", stance: "defend", argument: "Playwright cannot run 25 browsers at once on this Mac" } })] }));
    expect(md).toMatch(/## Where they disagreed/);
    expect(md).toMatch(/Playwright cannot run 25 browsers at once on this Mac/);
  });

  it("marks a rule-driven rejection apart from the Arbiter's judgement", () => {
    const md = renderNote(input({ decisions: [decision({ decision: "reject", byRule: true, why: "paid enrichment answer-database" })] }));
    expect(md).toMatch(/\| ⚖️ \| \*\*reject\*\*/);
    expect(md).toMatch(/decided by a standing rule in code/);
  });

  it("explains the ⚖️ mark only when something carries it", () => {
    expect(renderNote(input({ decisions: [decision()] }))).not.toContain("⚖️");
    expect(renderNote(input({ decisions: [decision({ byRule: true })] }))).toMatch(/decided by a standing rule in code/);
  });

  it("orders adopt before pilot before watch before reject", () => {
    const md = renderNote(input({ decisions: [decision({ id: "d", decision: "reject" }), decision({ id: "c", decision: "watch" }), decision({ id: "https://example.com/a", decision: "adopt" }), decision({ id: "b", decision: "pilot" })] }));
    const order = [...md.matchAll(/\*\*(adopt|pilot|watch|reject)\*\*/g)].map((m) => m[1]);
    expect(order).toEqual(["adopt", "pilot", "watch", "reject"]);
  });

  it("records what Jev had at the time, including the empty seams", () => {
    const md = renderNote(input({ decisions: [decision()] }));
    expect(md).toMatch(/declared with nothing behind them: `orgo`/);
  });

  it("does not pretend a pipe in a model's answer is a table column", () => {
    const md = renderNote(input({ decisions: [decision({ why: "good | bad" })] }));
    expect(md).toMatch(/good \\\| bad/);
  });
});

describe("writing into the vault", () => {
  it("writes the note and a linkable note per adopted item", () => {
    const v = vault();
    const written = writeNote(input({ decisions: [decision()] }), v);
    expect(existsSync(written.file)).toBe(true);
    expect(written.file).toMatch(/2026-09-28 Jev capability review\.md$/);
    expect(written.uri).toMatch(/^obsidian:\/\/open\?vault=/);
    expect(written.itemNotes).toHaveLength(1);
    // the [[link]] in the review must resolve to the note that was actually created
    expect(readFileSync(written.file, "utf8")).toContain("[[Steel an open-source browser API]]");
    expect(path.basename(written.itemNotes[0]!)).toBe("Steel an open-source browser API.md");
  });

  it("never overwrites an item note the user may have written on", () => {
    const v = vault();
    const first = writeNote(input({ decisions: [decision()] }), v);
    writeFileSync(first.itemNotes[0]!, "my own notes\n");
    const second = writeNote({ ...input({ decisions: [decision()] }), date: new Date("2026-10-05T13:00:00Z") }, v);
    expect(second.itemNotes).toEqual([]);
    expect(readFileSync(first.itemNotes[0]!, "utf8")).toBe("my own notes\n");
  });

  it("writes nothing extra for items that were only watched or rejected", () => {
    const v = vault();
    const w = writeNote(input({ decisions: [decision({ decision: "watch" })] }), v);
    expect(w.itemNotes).toEqual([]);
    expect(existsSync(path.join(v, REVIEW_FOLDER, "Steel an open-source browser API.md"))).toBe(false);
  });
});

describe("the index note", () => {
  it("is actually written, because every review links to it", () => {
    // "See [[Jev Capability Index]]" is a promise in every note; nothing kept it until now, which
    // is the same shape as the old hermes.ts line telling the brain it could read pages it couldn't
    const v = vault();
    const w = writeNote(input({ decisions: [decision()] }), v);
    const index = path.join(v, REVIEW_FOLDER, "Jev Capability Index.md");
    expect(existsSync(index)).toBe(true);
    expect(readFileSync(index, "utf8")).toContain("[[2026-09-28 Jev capability review]]");
    expect(readFileSync(w.file, "utf8")).toContain("[[Jev Capability Index]]");
  });

  it("gains a line per review, and replaces rather than duplicates a re-run", () => {
    const v = vault();
    writeNote(input({ decisions: [decision()] }), v);
    writeNote(input({ decisions: [decision()] }), v); // same date, re-run
    writeNote({ ...input({ decisions: [decision()] }), date: new Date("2026-10-05T13:00:00Z") }, v);
    const body = readFileSync(path.join(v, REVIEW_FOLDER, "Jev Capability Index.md"), "utf8");
    expect(body.match(/2026-09-28 Jev capability review/g)).toHaveLength(1);
    expect(body.match(/2026-10-05 Jev capability review/g)).toHaveLength(1);
  });
});

describe("Slack", () => {
  it("is skipped, not failed, with no webhook configured", async () => {
    await expect(postSlack("x", undefined)).resolves.toBe("slack: skipped (no JEV_REVIEW_SLACK_WEBHOOK set)");
    await expect(postSlack("x", "  ")).resolves.toBe("slack: skipped (no JEV_REVIEW_SLACK_WEBHOOK set)");
  });

  it("reports a failure without throwing — the note is already saved", async () => {
    const boom = (async () => {
      throw new Error("ENOTFOUND hooks.slack.com");
    }) as unknown as typeof fetch;
    await expect(postSlack("x", "https://hooks.slack.com/x", boom)).resolves.toMatch(/slack: failed \(ENOTFOUND/);
    const bad = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(postSlack("x", "https://hooks.slack.com/x", bad)).resolves.toBe("slack: failed (HTTP 500)");
  });

  it("carries the picks, the warning and where to read more", () => {
    const i = input({ decisions: [decision()], harvest: { staleWarning: "the pipeline stopped" } });
    const text = renderSlack(i, { file: "/v/note.md", uri: "obsidian://x", itemNotes: [] });
    expect(text).toMatch(/:warning: the pipeline stopped/);
    expect(text).toMatch(/\*adopt\* — <https:\/\/example\.com\/a\|Steel/);
    expect(text).toMatch(/Full note \(with the disagreements\)/);
  });

  it("says so plainly when nothing met the bar", () => {
    expect(renderSlack(input(), { file: "/v/n.md", uri: "", itemNotes: [] })).toMatch(/Nothing met the bar/);
  });
});
