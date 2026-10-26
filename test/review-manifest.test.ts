import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest, describeManifest, parseActions, parseExecutorKinds, parseExecutors, parseBrowserBoxActions, parseHttpRoutes, parseMacDriverCalls, probeLive, repoRoot } from "../server/review/manifest.js";

/** The manifest is what the twice-weekly review diffs new ecosystem items against. If it silently
 *  parses to nothing, every candidate looks like a gap and the review confidently recommends
 *  rebuilding things Jev already ships — so these tests are mostly about failing loudly. */
describe("capability manifest", () => {
  const root = repoRoot();
  // never probe a running companion from the suite: the result would depend on the developer's Mac
  const build = () => buildManifest({ baseUrl: null });

  it("covers every executor file — the rot guard", async () => {
    const files = readdirSync(path.join(root, "server", "executors")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const m = await build();
    expect(m.executors).toHaveLength(files.length);
    expect(m.executors.map((e) => path.basename(e.file)).sort()).toEqual([...files].sort());
  });

  it("records declared-but-unimplemented kinds separately from real surfaces", async () => {
    const m = await build();
    // "we have a seam for that but nothing behind it" is a different answer from "we don't have it"
    expect(m.planned).toContain("orgo");
    expect(m.planned).not.toContain("playwright"); // retired on purpose in v11, not a seam
    expect(describeManifest(m)).toMatch(/Retired on purpose[^\n]*playwright — replaced by browser-box/);
    expect(m.executors.map((e) => e.kind)).not.toContain("orgo");
    expect(m.executorKinds).toEqual(expect.arrayContaining(["playwright", "chrome", "mac", "orgo"]));
  });

  it("does not present a runtime-mutated capability as a fixed one", async () => {
    const m = await build();
    const chrome = m.executors.find((e) => e.id === "chrome");
    // remote.ts flips read on from the bridge handshake; reporting the literal `false` would tell
    // the review Jev cannot read his signed-in Chrome, which it can with a current extension
    expect(String(chrome?.capabilities.read)).toMatch(/^dynamic:/);
    const front = m.executors.find((e) => e.id === "front");
    expect(front?.kind).toBe("delegates");
    expect(front?.note).toMatch(/takes over their screen/);
  });

  it("carries the whole public surface area", async () => {
    const m = await build();
    expect(m.actions).toEqual(expect.arrayContaining(["navigate", "click", "type", "open_app", "open_path", "none"]));
    expect(m.brainTools).toEqual(["mac_read", "mac_act", "mac_control", "chrome", "browser_box", "shell", "cofounder", "orgo", "secret"]);
    expect(m.connectors.writes).toEqual(expect.arrayContaining(["SLACK_SEND_MESSAGE", "GMAIL_SEND_EMAIL"]));
    expect(m.browserBox).toEqual(expect.arrayContaining(["fetch", "read", "act", "session_create"]));
    // the Mac hands' background verbs, read from the executor itself
    expect(m.macDriver).toEqual(expect.arrayContaining(["get_window_state", "click", "invoke_menu", "set_value", "launch_app", "press_key"]));
    expect(m.httpRoutes).toEqual(expect.arrayContaining(["GET /api/health", "POST /api/command", "POST /api/read"]));
    expect(m.httpRoutes).not.toContain("POST /api/task"); // gone since v11: the review must not claim it
    expect(m.routes.map((r) => r.id)).toEqual(expect.arrayContaining(["browser_now", "computer", "hermes"]));
    expect(m.live).toBeNull();
  });

  it("refuses to report an empty parse as an empty capability set", () => {
    expect(() => parseActions("export type Action = never;")).toThrow(/expected at least/);
    expect(() => parseBrowserBoxActions("const tools = {};")).toThrow(/expected at least/);
    expect(() => parseMacDriverCalls("class Mac {}")).toThrow(/expected at least/);
    expect(() => parseHttpRoutes("const api = {};")).toThrow(/expected at least/);
    expect(() => parseExecutorKinds("export type Other = 'x';")).toThrow(/not found/);
    expect(() => parseExecutors(path.join(root, "core"))).toThrow();
  });

  it("describes itself as prose a model can read", async () => {
    const text = describeManifest(await build());
    expect(text).toMatch(/Declared but NOT implemented[^\n]*orgo/);
    expect(text).toMatch(/Not probed live/);
    // the Surveyor judges against what Jev is NOW: the brain, its tools and connectors
    expect(text).toMatch(/Brain tools \(named, nothing else\): mac_read, mac_act/);
    expect(text).toMatch(/in the background by app name/);
    expect(text).toMatch(/Composio/);
  });
});

describe("live probe", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("says why the surface list is empty rather than reporting no surfaces", async () => {
    // an unauthorised probe answering `sessions: []` reads exactly like a running app with nothing
    // attached — the review would then call every surface Jev has a gap
    const fake = (async (url: string) => (String(url).endsWith("/api/health") ? ok({ url: "x", paused: false }) : new Response("", { status: 401 }))) as unknown as typeof fetch;
    const live = await probeLive("http://127.0.0.1:1", undefined, fake);
    expect(live?.sessions).toEqual([]);
    expect(live?.problem).toMatch(/401.*no JEV_TOKEN/);
  });

  it("is null when nothing is listening, and never throws", async () => {
    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(probeLive("http://127.0.0.1:1", "t", dead)).resolves.toBeNull();
  });

  it("returns the attached surfaces when authorised", async () => {
    const fake = (async (url: string) => (String(url).endsWith("/api/health") ? ok({ url: "about:blank", paused: false }) : ok({ sessions: [{ id: "playwright", kind: "playwright", ready: true }] }))) as unknown as typeof fetch;
    const live = await probeLive("http://127.0.0.1:1", "t", fake);
    expect(live?.sessions).toEqual([{ id: "playwright", kind: "playwright", ready: true }]);
    expect(live?.problem).toBeUndefined();
  });
});
