import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { OneShot } from "../server/brain/oneshot.js";
import type { BoxResult, BrowserBox } from "../server/browserbox.js";
import { investigate } from "../server/review/investigate.js";
import type { WatchItem } from "../server/review/sheet.js";

const item = (key: string, url: string) => ({ key, url, title: key }) as unknown as WatchItem;

/** A browser-box stand-in: answers fetch/read per URL from a table, and records every call. */
function fakeBox(pages: Record<string, { fetch?: string; read?: string }>, opts: { down?: boolean } = {}) {
  const calls: Array<{ tool: string; url?: string }> = [];
  const box = {
    async call(tool: string, body: { url?: string } | null): Promise<BoxResult> {
      calls.push({ tool, ...(body?.url ? { url: body.url } : {}) });
      if (tool === "status") {
        if (opts.down) throw new Error("fetch failed");
        return { ok: true };
      }
      const page = pages[body!.url!] ?? {};
      if (tool === "fetch") return { text: page.fetch ?? "", title: "T" };
      if (tool === "read") return { text: page.read ?? "", title: "T" };
      return {};
    },
  } as unknown as BrowserBox;
  return { box, calls };
}

const oneshot = (answer: (user: string) => string | null) =>
  ({
    async json<T>(_system: string, user: string, schema: z.ZodType<T>): Promise<T> {
      return schema.parse({ answer: answer(user) });
    },
  }) as unknown as OneShot;

describe("the investigation pass reads pages through Jev's own browser", () => {
  const long = (s: string) => `${s} `.repeat(80);

  it("fetches each shortlisted page, falls back to a real browser for thin pages, and asks the model about what it read", async () => {
    const { box, calls } = fakeBox({ "https://a.test": { fetch: long("Alpha is a free CLI.") }, "https://b.test": { fetch: "Loading…", read: long("Beta needs an API key.") } });
    const { findings, note } = await investigate([item("a", "https://a.test"), item("b", "https://b.test")], { box, oneshot: oneshot((u) => (u.includes("Alpha") ? "free CLI" : "needs a key")) });
    expect(findings.map((f) => [f.id, f.status, f.answer])).toEqual([
      ["a", "ok", "free CLI"],
      ["b", "ok", "needs a key"],
    ]);
    expect(calls.filter((c) => c.tool === "read").map((c) => c.url)).toEqual(["https://b.test"]);
    expect(note).toBeNull();
  });

  it("says by name that nothing was read when browser-box is down — never a quiet 'from the Sheet'", async () => {
    const { box } = fakeBox({}, { down: true });
    const { findings, note } = await investigate([item("a", "https://a.test")], { box, oneshot: oneshot(() => "x") });
    expect(findings[0]).toMatchObject({ status: "not-investigated", error: expect.stringMatching(/browser-box wasn't running/) });
    expect(note).toMatch(/browser-box wasn't answering/);
  });

  it("says so when browser-box isn't set up at all", async () => {
    const { findings, note } = await investigate([item("a", "https://a.test")], { box: null, oneshot: oneshot(() => "x") });
    expect(findings[0]!.status).toBe("not-investigated");
    expect(note).toMatch(/isn't configured/);
  });

  it("a page that cannot be read costs that row only, and the note counts it", async () => {
    const { box } = fakeBox({ "https://a.test": { fetch: long("ok page") }, "https://b.test": {} });
    const { findings, note } = await investigate([item("a", "https://a.test"), item("b", "https://b.test")], { box, oneshot: oneshot(() => "fine") });
    expect(findings.map((f) => f.status)).toEqual(["ok", "failed"]);
    expect(findings[1]!.error).toMatch(/no readable text/);
    expect(note).toMatch(/1 of 2/);
  });

  it("opens at most the cap, and skips rows with no usable URL", async () => {
    const pages = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`https://x${i}.test`, { fetch: long("page") }]));
    const { box } = fakeBox(pages);
    const items = [item("bad", "not a url"), ...Array.from({ length: 20 }, (_, i) => item(`x${i}`, `https://x${i}.test`))];
    const { findings } = await investigate(items, { box, oneshot: oneshot(() => "y"), max: 5 });
    expect(findings.map((f) => f.id)).toEqual(["x0", "x1", "x2", "x3", "x4"]);
  });
});
