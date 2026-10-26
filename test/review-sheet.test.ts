import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NOT_AUTHED, WATCH_SHEET_ID, authTrouble, harvest, looksLikeCsv, normalizeGvizDate, parseCsv, publicCsvUrl, readTab, readTabPublic, requireColumns, summarise, toObjects } from "../server/review/sheet.js";
import { FIRST_RUN_DAYS, readReviewState, recordReviewed, writeReviewState } from "../server/review/state.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const freshFile = () => {
  const d = mkdtempSync(path.join(tmpdir(), "jev-review-"));
  dirs.push(d);
  return path.join(d, "review", "state.json");
};

/** The REAL all-items header, read out of the pipeline's sheets_sync.py on 2026-09-24. Note what it
 *  does NOT have: no `id` column at all, and the database's `fetched` is published as FIRST_SEEN.
 *  Keying on either — which the first draft did — would have thrown on the first authenticated run. */
const HEADER = "PLATFORM,KIND,SOURCE,TITLE,AUTHOR,PUBLISHED,URL,SEEN,FIRST_SEEN,SUMMARY\n";
const row = (id: string, firstSeen: string, title = `item ${id}`) => `github,repo,github,"${title}",someone,2026-09-20,https://example.com/${id},0,${firstSeen},"a summary, with a comma"\n`;
const csv = (...rows: string[]) => HEADER + rows.join("");
const execOk = (text: string) => async () => text;
const NOW = new Date("2026-09-24T12:00:00Z");
const url = (id: string) => `https://example.com/${id}`;

describe("CSV from the Sheet", () => {
  it("survives commas, quotes and newlines inside fields", () => {
    expect(parseCsv('a,b\n"one, two","he said ""hi""\nsecond line"\n')).toEqual([
      ["a", "b"],
      ["one, two", 'he said "hi"\nsecond line'],
    ]);
  });

  it("matches the pipeline's SHOUTING_LABELS regardless of case or separators", () => {
    expect(toObjects(parseCsv("URL,FIRST_SEEN,Rank Note\nhttps://x,2026-09-23,good\n"))[0]).toEqual({ url: "https://x", firstseen: "2026-09-23", ranknote: "good" });
  });
});

describe("making sense of a real all-items row", () => {
  it("keys on the URL and reads FIRST_SEEN, because there is no id or fetched column", () => {
    const items = requireColumns(toObjects(parseCsv(csv(row("a", "2026-09-23T10:00:00")))), "all-items");
    expect(items[0]).toMatchObject({ key: url("a"), url: url("a"), seenAt: "2026-09-23T10:00:00", title: "item a" });
  });

  it("accepts whichever name the pipeline gives the date column, and says what it found when there is none", () => {
    expect(requireColumns(toObjects(parseCsv("URL,TITLE,FETCHED\nhttps://x,t,2026-09-23\n")), "t")[0]?.seenAt).toBe("2026-09-23");
    expect(() => requireColumns(toObjects(parseCsv("URL,TITLE\nhttps://x,t\n")), "all-items")).toThrow(/missing one of firstseen\/fetched\/collected\/published — it has url, title/);
  });

  it("refuses a tab with no URL column instead of guessing", () => {
    expect(() => requireColumns(toObjects(parseCsv("TITLE,SUMMARY\nx,y\n")), "all-items")).toThrow(/missing url/);
  });

  it("refuses a header with no rows under it", () => {
    expect(() => requireColumns([], "all-items")).toThrow(/header but no rows/);
  });
});

describe("reading a tab", () => {
  it("names the one-time fix when gws has no credentials", async () => {
    // Verbatim from a live launchd run on 2026-09-24: gws puts this on STDOUT, leaves stderr empty
    // and exits 1. Scanning only stderr made this message unreachable through the path the
    // scheduled job actually takes, and the user would have seen "couldn't read the tab" instead of
    // the one instruction that fixes it.
    const payload = JSON.stringify({ error: { code: 401, message: "Access denied. No credentials provided. Run `gws auth login` or set GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE to an OAuth credentials JSON file.", reason: "authError" } }, null, 2);
    const dead = async () => {
      throw Object.assign(new Error("Command failed: gws sheets +read ..."), { stdout: payload, stderr: "" });
    };
    const err = await readTab("all-items", { exec: dead }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain(NOT_AUTHED);
    expect(err?.message).toContain("Run `gws auth login`");
    expect(err?.message).not.toContain('"reason"');
  });

  it("does not parse an error object that exited 0 as a one-row CSV", async () => {
    await expect(readTab("all-items", { exec: async () => JSON.stringify({ error: { code: 401, message: "Access denied.", reason: "authError" } }) })).rejects.toThrow(NOT_AUTHED);
  });

  it("treats a completely empty read as a failure, not an empty pipeline", async () => {
    await expect(readTab("all-items", { exec: execOk("") })).rejects.toThrow(/failed read, not an empty pipeline/);
  });
});

describe("the review's own watermark", () => {
  it("looks at a bounded window on the very first run, not the whole database", async () => {
    // all-items is "every row in the database" — without a window the first run would scout years
    const h = await harvest({}, { exec: execOk(csv(row("ancient", "2020-01-01T00:00:00"), row("new", "2026-09-23T00:00:00"))) }, NOW);
    expect(h.all).toHaveLength(2);
    expect(h.fresh.map((i) => i.key)).toEqual([url("new")]);
    expect(FIRST_RUN_DAYS).toBe(7);
  });

  it("only shows each item once, across runs", async () => {
    const file = freshFile();
    const sheet = { exec: execOk(csv(row("a", "2026-09-23T00:00:00"), row("b", "2026-09-23T00:00:00"))) };

    const first = await harvest(readReviewState(file), sheet, NOW);
    expect(first.fresh.map((i) => i.key)).toEqual([url("a"), url("b")]);

    recordReviewed(first.fresh, [], first.newestSeenAt, file, () => NOW);
    expect((await harvest(readReviewState(file), sheet, NOW)).fresh).toEqual([]);

    const third = await harvest(readReviewState(file), { exec: execOk(csv(row("a", "2026-09-23T00:00:00"), row("c", "2026-09-24T09:00:00"))) }, NOW);
    expect(third.fresh.map((i) => i.key)).toEqual([url("c")]);
  });

  it("brings back a row the run never actually considered", async () => {
    // The failure this guards: a row lost to a failed Scout batch, or cut by the shortlist cap,
    // used to be marked reviewed along with everything else and was never seen again.
    const file = freshFile();
    const sheet = { exec: execOk(csv(row("a", "2026-09-23T00:00:00"), row("lost", "2026-09-23T01:00:00"))) };
    const first = await harvest(readReviewState(file), sheet, NOW);

    recordReviewed(
      first.fresh.filter((i) => i.key === url("a")),
      [],
      first.newestSeenAt,
      file,
      () => NOW,
    );

    expect((await harvest(readReviewState(file), sheet, NOW)).fresh.map((i) => i.key)).toEqual([url("lost")]);
  });

  it("does not move the cutoff past rows it skipped", async () => {
    const file = freshFile();
    const sheet = { exec: execOk(csv(row("early", "2026-09-22T00:00:00"), row("late", "2026-09-24T00:00:00"))) };
    const first = await harvest(readReviewState(file), sheet, NOW);
    // considered only the OLDER one; the cutoff must not jump to the newer row's date
    recordReviewed(
      first.fresh.filter((i) => i.key === url("early")),
      [],
      first.newestSeenAt,
      file,
      () => NOW,
    );
    expect((await harvest(readReviewState(file), sheet, NOW)).fresh.map((i) => i.key)).toEqual([url("late")]);
  });

  it("does not strand a skipped row that is OLDER than one it did consider", async () => {
    // The order matters and the earlier test missed it. A capped or partly failed run considers
    // rows out of date order — batch 40 succeeds, batch 3 threw — so the cutoff jumps to the newest
    // row it answered on and the older skipped rows fall behind it. The 12h overlap cannot reach
    // days back, so they are gone for good with nothing to say so.
    const file = freshFile();
    const sheet = { exec: execOk(csv(row("lost", "2026-09-20T00:00:00"), row("done", "2026-09-24T00:00:00"))) };
    const first = await harvest(readReviewState(file), sheet, NOW);

    recordReviewed(
      first.fresh.filter((i) => i.key === url("done")),
      first.fresh.filter((i) => i.key === url("lost")),
      first.newestSeenAt,
      file,
      () => NOW,
    );

    expect((await harvest(readReviewState(file), sheet, NOW)).fresh.map((i) => i.key)).toEqual([url("lost")]);
  });

  it("does not advance when a run dies before publishing", async () => {
    const file = freshFile();
    await harvest(readReviewState(file), { exec: execOk(csv(row("a", "2026-09-23T00:00:00"))) }, NOW);
    // harvest() reads state; only recordReviewed() writes it
    expect(readReviewState(file).reviewed ?? {}).toEqual({});
  });

  it("forgets reviewed rows by age, so old ones cannot resurface as new", async () => {
    // A count-capped id list starts dropping its oldest entries while those rows are still in the
    // Sheet, and they then look new on every run forever after. Age-based pruning cannot do that:
    // anything pruned is already far behind the cutoff.
    const file = freshFile();
    writeReviewState({ cutoff: "2026-09-24T00:00:00.000Z", reviewed: { [url("ancient")]: "2020-01-01T00:00:00", [url("recent")]: "2026-09-23T00:00:00" } }, file);
    recordReviewed([{ key: url("x"), seenAt: "2026-09-24T00:00:00" }], [], null, file, () => NOW);
    const kept = Object.keys(readReviewState(file).reviewed ?? {});
    expect(kept).toContain(url("recent"));
    expect(kept).not.toContain(url("ancient"));
    // and the pruned one is far enough behind the cutoff that it can never be "fresh" again
    expect((await harvest(readReviewState(file), { exec: execOk(csv(row("ancient", "2020-01-01T00:00:00"))) }, NOW)).fresh).toEqual([]);
  });

  it("re-checks a short overlap window against the id map, for clock skew", async () => {
    const file = freshFile();
    writeReviewState({ cutoff: "2026-09-24T00:00:00.000Z", reviewed: { [url("a")]: "2026-09-23T20:00:00" } }, file);
    // both rows sit inside the 12h overlap; only "a" has already been reviewed
    const h = await harvest(readReviewState(file), { exec: execOk(csv(row("a", "2026-09-23T20:00:00"), row("b", "2026-09-23T20:00:00"))) }, NOW);
    expect(h.fresh.map((i) => i.key)).toEqual([url("b")]);
  });
});

describe("what the Scout is actually given", () => {
  // the user's call, 2026-09-25: the review scouts what HIS pipeline ranked, and invents no bar of its
  // own. all-items is the whole database (5,595 rows live, against 1,818 ranked) so scouting it whole
  // is ~373 sequential model calls — a first run that reads as a hang.
  const RANKED_HEADER = "SCORE,RELEVANCE,CATEGORY,PLATFORM,KIND,TITLE,AUTHOR,PUBLISHED,URL,SUMMARY,ALSO_ON,FIRST_SEEN\n";
  const rankedRow = (id: string) => `80,90,core,github,repo,"item ${id}",someone,2026-09-20,https://example.com/${id},"s",,2026-09-23T00:00:00\n`;
  /** Serve a different tab to each read, the way the real Sheet does. */
  const byTab = (all: string, ranked: string) => async (_bin: string, args: string[]) => (args.join(" ").includes("ranked-items") ? ranked : all);

  it("scouts only what the pipeline ranked, and says how many it did not", async () => {
    const h = await harvest({}, {
      exec: byTab(csv(row("kept", "2026-09-23T00:00:00"), row("unranked", "2026-09-23T00:00:00")), RANKED_HEADER + rankedRow("kept")),
    }, NOW);
    expect(h.fresh).toHaveLength(2);
    expect(h.eligible.map((i) => i.key)).toEqual([url("kept")]);
    expect(h.unranked.map((i) => i.key)).toEqual([url("unranked")]);
  });

  it("does not hand the Scout the same URL twice", async () => {
    // all-items repeats a URL across rows (5,595 rows, 5,225 distinct URLs live). Asking about the
    // same page twice costs a model call and puts the row in a batch beside itself.
    const h = await harvest({}, {
      exec: byTab(csv(row("dup", "2026-09-23T00:00:00"), row("dup", "2026-09-23T06:00:00")), RANKED_HEADER + rankedRow("dup")),
    }, NOW);
    expect(h.fresh).toHaveLength(2);
    expect(h.eligible).toHaveLength(1);
  });

  it("holds a row the ranker has not reached yet, instead of marking it decided", async () => {
    // The distinction that makes this necessary: "unranked" and "not ranked YET" have opposite
    // consequences. all-items and ranked-items are two separate reads of a Sheet the pipeline
    // rewrites at 13:00 UTC — which is exactly 09:00 America/New_York, when this job runs — so the
    // harvest tab can legitimately be ahead of the ranked tab. Treating that row as screened would
    // advance the cutoff past it and lose it for good.
    const file = freshFile();
    const sheet = {
      exec: byTab(csv(row("ranked", "2026-09-22T00:00:00"), row("ahead", "2026-09-24T00:00:00")), RANKED_HEADER + rankedRow("ranked")),
    };
    const h = await harvest(readReviewState(file), sheet, NOW);
    expect(h.eligible.map((i) => i.key)).toEqual([url("ranked")]);
    expect(h.notYetRanked.map((i) => i.key)).toEqual([url("ahead")]);
    expect(h.unranked).toEqual([]);

    recordReviewed([...h.eligible], [...h.notYetRanked], h.newestSeenAt, file, () => NOW);

    // it must come back once the ranker catches up
    expect((await harvest(readReviewState(file), sheet, NOW)).fresh.map((i) => i.key)).toEqual([url("ahead")]);
  });

  it("says so when the harvest is running but the ranker has stopped", async () => {
    // Otherwise "0 scouted, N not scouted" reads as policy rather than as a dead ranker.
    const h = await harvest({}, {
      exec: byTab(csv(row("old", "2026-09-15T00:00:00"), row("new", "2026-09-24T00:00:00")), RANKED_HEADER + rankedRow("old").replace("2026-09-23T00:00:00", "2026-09-15T00:00:00")),
    }, NOW);
    expect(h.staleWarning).toMatch(/still harvesting .* but has ranked nothing since/);
  });

  it("fails loudly when ranked-items cannot be read, rather than scouting nothing", async () => {
    // This tab is load-bearing now. Falling through with an empty map — which is what the code did
    // while it was only "useful context" — would make every row ineligible and produce a clean,
    // confident review of zero items with nothing reporting a failure.
    await expect(
      harvest({}, {
        exec: async (_b: string, args: string[]) => {
          if (args.join(" ").includes("ranked-items")) throw new Error("no such tab");
          return csv(row("a", "2026-09-23T00:00:00"));
        },
      }, NOW),
    ).rejects.toThrow(/ranked-items" tab is unreadable, and the review keys its intake on it/);
  });

  it("fails loudly when ranked-items is readable but empty", async () => {
    await expect(harvest({}, { exec: byTab(csv(row("a", "2026-09-23T00:00:00")), RANKED_HEADER) }, NOW)).rejects.toThrow(/held no rows with a URL/);
  });
});

describe("staleness", () => {
  it("says plainly when the daily pipeline has stopped", () => {
    const all = requireColumns(toObjects(parseCsv(csv(row("a", "2026-09-15T00:00:00")))), "t");
    expect(summarise(all, {}, new Date("2026-09-23T12:00:00Z")).staleWarning).toMatch(/harvested nothing since 2026-09-15T00:00:00 \(8 days ago\)/);
  });

  it("is quiet when the pipeline ran today", () => {
    const all = requireColumns(toObjects(parseCsv(csv(row("a", "2026-09-23T00:00:00")))), "t");
    expect(summarise(all, {}, new Date("2026-09-23T12:00:00Z")).staleWarning).toBeNull();
  });

  it("copes with the space-separated form SQLite writes", () => {
    const all = requireColumns(toObjects(parseCsv(csv(row("a", "2026-09-23 08:00:00")))), "t");
    const s = summarise(all, {}, new Date("2026-09-23T12:00:00Z"));
    expect(s.staleWarning).toBeNull();
    expect(s.newestSeenAt).toBe("2026-09-23 08:00:00");
  });

  it("says so when no row has a readable date at all", () => {
    const all = requireColumns(toObjects(parseCsv(csv(row("a", "")))), "t");
    expect(summarise(all, {}, NOW).staleWarning).toMatch(/cannot tell whether the daily pipeline is still running/);
  });
});

describe("reading the Sheet with no credential at all", () => {
  const ok = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

  it("reads the tab over plain HTTPS, and never shells out to gws when it works", async () => {
    let shelled = false;
    const rows = await readTab("all-items", {
      fetch: ok('"URL","TITLE","SEEN","FIRST_SEEN"\n"http://a","A","","2026-09-24T13:05:06"\n'),
      exec: async () => {
        shelled = true;
        return "";
      },
    });
    expect(rows).toEqual([{ url: "http://a", title: "A", seen: "", firstseen: "2026-09-24T13:05:06" }]);
    // the whole point: a launchd job with no login session and no keyring reaches the Sheet anyway
    expect(shelled).toBe(false);
  });

  it("asks the visualisation endpoint for the named tab as CSV", () => {
    expect(publicCsvUrl("all-items")).toBe(`https://docs.google.com/spreadsheets/d/${WATCH_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=all-items`);
    expect(publicCsvUrl("ranked items", "sheet-2")).toContain("sheet=ranked%20items");
  });

  it("refuses a sign-in page instead of parsing it as one CSV row", async () => {
    // A sheet that is not link-shared answers 200 with HTML. Its first line has no comma, so a CSV
    // parser returns it as a single field — a clean empty review that nothing reports as failed.
    // The real body, as observed 2026-09-25: note the commas — a comma check alone would pass it.
    const signin = '<!DOCTYPE html><html lang="en"><head><script nonce="9b2g">window[\'ppConfig\'] = {productName: \'x\', deleteIsEnforced: false, sealIsEnforced: false};</script>';
    expect(signin.split("\n")[0]).toContain(",");
    expect(looksLikeCsv(signin)).toBe(false);
    await expect(readTabPublic("all-items", { fetch: ok(signin) })).rejects.toThrow(/sign-in page rather than CSV/);
  });

  it("falls back to gws when the Sheet is no longer readable by link", async () => {
    const rows = await readTab("all-items", {
      fetch: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
      exec: async () => '"URL","TITLE","SEEN","FIRST_SEEN"\n"http://b","B","","2026-09-24T13:05:06"\n',
    });
    expect(rows[0]?.url).toBe("http://b");
  });

  it("refuses the first tab when the one it asked for has been renamed", async () => {
    // gviz answers an unknown tab name with HTTP 200 and the spreadsheet's FIRST tab — verified live
    // 2026-09-25. ranked-items carries url, title and first_seen, so requireColumns would accept it
    // and the review would run against the ranked subset believing it had the whole database.
    const ranked = '"SCORE","CATEGORY","TITLE","URL","FIRST_SEEN"\n"99.5","core","awesome-jev","http://x","2026-09-23T10:25:54"\n';
    await expect(readTabPublic("all-items", { fetch: ok(ranked) })).rejects.toThrow(/without its "seen" column .* probably been renamed/s);
    // and the right tab under its own name is fine
    await expect(readTabPublic("ranked-items", { fetch: ok(ranked) })).resolves.toHaveLength(1);
  });

  it("converts a gviz date cell back to something the watermark can read", () => {
    // gviz renders a date-TYPED cell as Date(y,m,d,…) with a zero-based month. Left alone, every
    // seenAt would be unparseable and the cutoff would never advance, with nothing looking wrong.
    expect(normalizeGvizDate("Date(2026,8,19,13,5,6)")).toBe("2026-09-19T13:05:06");
    expect(normalizeGvizDate("Date(2026,0,1)")).toBe("2026-01-01T00:00:00");
    expect(normalizeGvizDate("2026-09-24T13:05:06")).toBe("2026-09-24T13:05:06");
    expect(normalizeGvizDate("not a date")).toBe("not a date");
  });
});

describe("asking gws about itself before asking it for data", () => {
  const status = (body: unknown) => async () => JSON.stringify(body, null, 2);

  it("says nothing when the credentials are actually usable", async () => {
    await expect(authTrouble({ exec: status({ auth_method: "oauth2", encryption_valid: true }) })).resolves.toBeNull();
  });

  it("tells a never-authenticated machine to log in", async () => {
    const t = await authTrouble({ exec: status({ auth_method: "none", plain_credentials_exists: false }) });
    expect(t).toMatch(/no credentials at all/);
    expect(t).toMatch(/gws auth login/);
  });

  it("tells a machine holding an undecryptable file to LOG OUT first", async () => {
    // Observed live on 2026-09-25 (gws 0.9.1): `gws auth login` on top of a credentials.enc it cannot
    // decrypt completes the browser flow, prints "Authentication successful. Encrypted credentials
    // saved.", and writes nothing. Telling the user to just log in again is an instruction that loops.
    const t = await authTrouble({
      exec: status({ auth_method: "oauth2", encryption_valid: false, encryption_error: "Could not decrypt. May have been created on a different machine." }),
    });
    expect(t).toMatch(/gws auth logout/);
    expect(t!.indexOf("logout")).toBeLessThan(t!.indexOf("login")); // the order is the fix
    expect(t).toMatch(/Could not decrypt/);
    expect(t).toMatch(/encryption_valid: true/); // and how to check it actually took
  });

  it("does not complain about a broken encrypted store when a plain credentials file is there", async () => {
    // The route around gws 0.9.1's unreadable credentials.enc IS a plain credentials.json, and it takes
    // priority — so flagging the encrypted store then would be an alarm about something unused.
    await expect(
      authTrouble({
        exec: status({ auth_method: "oauth2", encryption_valid: false, encryption_error: "Could not decrypt.", plain_credentials_exists: true }),
      }),
    ).resolves.toBeNull();
  });

  it("stays quiet when it cannot read the status at all, rather than inventing a diagnosis", async () => {
    await expect(authTrouble({ exec: async () => "gws: command not found" })).resolves.toBeNull();
    await expect(
      authTrouble({
        exec: async () => {
          throw new Error("spawn ENOENT");
        },
      }),
    ).resolves.toBeNull();
  });
});
