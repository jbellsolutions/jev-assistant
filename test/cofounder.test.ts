/** The co-founder hand-off: over Orgo's API, never starting the computer, never letting the
 *  message near a shell, and never running the same task twice on a retry. */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COFOUNDER_COMPUTER, Cofounder, type Delivery, newRequestId, studioScript } from "../server/cofounder.js";

// Copied to a path without spaces: the real on-box paths have none, and the script (rightly) does not
// quote a fixed path — this repo's own path ("Jev Claude Code") would otherwise split.
const FAKE = path.join(mkdtempSync(path.join(tmpdir(), "fake-studio-")), "rpc.py");
copyFileSync(path.join(import.meta.dirname, "fixtures", "fake-studio-rpc.py"), FAKE);
const HOSTILE = `it's "$(touch /tmp/pwned)" \`rm -rf ~\` $HOME\nsecond line; exit 0 # ok?`;

/** Runs the generated script in a real local shell against the fake Studio. */
function runScript(script: string, mode = "complete", dir = mkdtempSync(path.join(tmpdir(), "studio-"))) {
  const log = path.join(dir, "calls.jsonl");
  let out = "";
  try {
    out = execFileSync("/bin/bash", ["-c", script], { env: { ...process.env, FAKE_STUDIO_LOG: log, FAKE_STUDIO_MODE: mode }, encoding: "utf8" });
  } catch (err) {
    out = String((err as { stdout?: string }).stdout ?? "");
  }
  const calls = (() => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> });
    } catch {
      return [];
    }
  })();
  return { out: out.trim(), calls };
}
const local = { py: "python3", rpc: FAKE };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

describe("the script sent to the co-founder's computer", () => {
  it("carries the user's words intact and never as shell", () => {
    const requestId = newRequestId();
    const script = studioScript({ computerId: COFOUNDER_COMPUTER, requestId, sendB64: b64({ operation: "send", recipient: "default", message: HOSTILE, request_id: requestId }), rounds: 1, waitSeconds: 0, ...local });
    expect(script).not.toContain("touch");
    expect(script).not.toContain("second line");
    const { out, calls } = runScript(script);
    expect(calls[0]!.params).toEqual({ operation: "send", recipient: "default", message: HOSTILE, request_id: requestId });
    const d = JSON.parse(out) as Delivery;
    expect(d).toEqual({ id: requestId, state: "complete", result: "I'm on Orgo 00000000, us-east." });
    expect(out).not.toContain("someone else's"); // only our delivery comes back, never the whole ledger
  });

  it("reports a still-running hand-off after its rounds, and a refusal by its reason", () => {
    const requestId = newRequestId();
    const send = b64({ operation: "send", recipient: "default", message: "hi", request_id: requestId });
    const slow = runScript(studioScript({ computerId: COFOUNDER_COMPUTER, requestId, sendB64: send, rounds: 2, waitSeconds: 0, ...local }), "running");
    expect(JSON.parse(slow.out)).toMatchObject({ id: requestId, state: "running" });
    expect(slow.calls.map((c) => c.params.operation)).toEqual(["send", "wait", "wait", "status"]);
    const refused = runScript(studioScript({ computerId: COFOUNDER_COMPUTER, requestId, sendB64: send, rounds: 1, waitSeconds: 0, ...local }), "refuse");
    expect(JSON.parse(refused.out)).toMatchObject({ state: "rpc_error", result: expect.stringContaining("already used") });
    const denied = runScript(studioScript({ computerId: COFOUNDER_COMPUTER, requestId, rounds: 0, waitSeconds: 0, ...local }), "permission");
    expect(JSON.parse(denied.out)).toMatchObject({ state: "rpc_error", result: expect.stringContaining("PermissionError") });
  });

  it("accepts only ids and base64 into the script", () => {
    expect(() => studioScript({ computerId: "x; rm -rf /", requestId: newRequestId(), rounds: 0, waitSeconds: 0 })).toThrow(/computer id/);
    expect(() => studioScript({ computerId: COFOUNDER_COMPUTER, requestId: "'$(id)'", rounds: 0, waitSeconds: 0 })).toThrow(/request id/);
    expect(() => studioScript({ computerId: COFOUNDER_COMPUTER, requestId: newRequestId(), sendB64: "a'b", rounds: 0, waitSeconds: 0 })).toThrow(/payload/);
  });
});

/** Orgo's API, faked: a computer status and a bash endpoint that runs the script locally. */
function orgo(status = "running", mode = "complete") {
  const calls: Array<{ method: string; path: string }> = [];
  const dir = mkdtempSync(path.join(tmpdir(), "studio-"));
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const p = url.replace("https://www.orgo.ai/api", "");
    calls.push({ method: String(init.method), path: p });
    if (init.method === "GET") return new Response(JSON.stringify({ status }), { status: 200 });
    const { command } = JSON.parse(String(init.body)) as { command: string };
    const localised = command.replaceAll("/opt/hermes-orgo-studio/venv/bin/python", "python3").replaceAll('-c "$R"', FAKE);
    return new Response(JSON.stringify({ output: runScript(localised, mode, dir).out }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl, dir };
}

describe("Cofounder", () => {
  it("hands off and returns the reply", async () => {
    const o = orgo();
    const c = new Cofounder({ apiKey: "sk_test", fetch: o.fetchImpl });
    const d = await c.send("where are you running?", newRequestId(), { rounds: 1, waitSeconds: 0 });
    expect(d.state).toBe("complete");
    expect(d.result).toMatch(/Orgo/);
    expect(o.calls.map((x) => x.method)).toEqual(["GET", "POST"]); // status checked before every bash
  });

  it("never runs anything on a computer that isn't running — so it can't be what starts it", async () => {
    const o = orgo("stopped");
    const c = new Cofounder({ apiKey: "sk_test", fetch: o.fetchImpl });
    await expect(c.send("hi")).rejects.toThrow(/is stopped\. I won't start it/);
    expect(o.calls.filter((x) => x.method === "POST")).toEqual([]);
    expect(o.calls.some((x) => /start|stop/.test(x.path))).toBe(false);
  });

  it("names the problem when Orgo's shell can't read the Studio", async () => {
    const c = new Cofounder({ apiKey: "sk_test", fetch: orgo("running", "permission").fetchImpl });
    await expect(c.check(newRequestId())).rejects.toThrow(/isn't running as root/);
  });

  it("keeps checking a slow hand-off and reports it when it lands — then stops", async () => {
    let mode = "running";
    const o = orgo();
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (init.method === "POST") {
        const { command } = JSON.parse(String(init.body)) as { command: string };
        const localised = command.replaceAll("/opt/hermes-orgo-studio/venv/bin/python", "python3").replaceAll('-c "$R"', FAKE);
        return new Response(JSON.stringify({ output: runScript(localised, mode, o.dir).out }), { status: 200 });
      }
      return o.fetchImpl(url, init);
    }) as typeof fetch;
    const c = new Cofounder({ apiKey: "sk_test", fetch: fetchImpl });
    const requestId = newRequestId();
    await c.send("research competitors", requestId, { rounds: 1, waitSeconds: 0 });
    const late: Delivery[] = [];
    c.onLate((d) => late.push(d));
    const queue: Array<() => void> = [];
    c.watch(requestId, "research competitors", { schedule: (fn) => void queue.push(fn) });
    queue.shift()!();
    await new Promise((r) => setTimeout(r, 400));
    expect(late).toEqual([]); // still running: checks again
    expect(queue).toHaveLength(1);
    mode = "complete";
    queue.shift()!();
    await new Promise((r) => setTimeout(r, 400));
    expect(late.map((d) => d.state)).toEqual(["complete"]);
    expect(queue).toHaveLength(0);
  });
});

describe("a late reply", () => {
  it("is announced as its own entry, spoken as a reply, and a give-up says so", async () => {
    const { wireCofounder } = await import("../server/cofounder.js");
    const c = new Cofounder({ apiKey: "sk_test", fetch: orgo().fetchImpl });
    const said: Array<{ from: string; text: string; level?: string; spoken?: string }> = [];
    wireCofounder(c, (from, text, level, spoken) => said.push({ from, text, level, spoken }));
    const fire = (d: Delivery) => (c as unknown as { lateListeners: Set<(d: Delivery, m: string) => void> }).lateListeners.forEach((fn) => fn(d, "research competitors"));
    fire({ id: "a", state: "complete", result: "Top 3: A, B, C." });
    fire({ id: "b", state: "gave_up", result: "" });
    expect(said[0]).toMatchObject({ from: "↩ The co-founder replied", text: "Top 3: A, B, C.", level: "ok", spoken: "The co-founder replied. Top 3: A, B, C." });
    expect(said[1]).toMatchObject({ level: "warn", text: expect.stringContaining("stopped checking") });
  });
});

describe("the co-founder's live desktop", () => {
  it("only ever connects to Orgo's own desktop sockets", async () => {
    const { vncSocketUrl } = await import("../server/cofounder.js");
    expect(vncSocketUrl("https://abc.orgo.dev/desktops/d_123/")).toBe("wss://abc.orgo.dev/desktops/d_123/ws/websockify");
    expect(() => vncSocketUrl("http://abc.orgo.dev/desktops/d_123")).toThrow(/looks wrong/);
    expect(() => vncSocketUrl("https://evil.test/steal?x=1")).toThrow(/looks wrong/);
    expect(() => vncSocketUrl("")).toThrow(/no desktop address/);
  });

  it("fetches a fresh password each time, never logs it, and never on a stopped computer", async () => {
    const calls: string[] = [];
    const mk = (status: string) =>
      new Cofounder({
        apiKey: "sk_test",
        fetch: (async (url: string) => {
          calls.push(url);
          if (url.endsWith("/vnc-password")) return new Response(JSON.stringify({ password: "pw-secret-1" }));
          return new Response(JSON.stringify({ status, connection_url: "https://abc.orgo.dev/desktops/d_1" }));
        }) as typeof fetch,
      });
    const logged: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    for (const k of ["log", "error", "warn"] as const) console[k] = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      const v = await mk("running").view();
      expect(v).toEqual({ wsUrl: "wss://abc.orgo.dev/desktops/d_1/ws/websockify?token=pw-secret-1", password: "pw-secret-1" });
      calls.length = 0;
      await expect(mk("stopped").view()).rejects.toThrow(/won't start it/);
      expect(calls.some((u) => u.endsWith("/vnc-password"))).toBe(false);
    } finally {
      Object.assign(console, orig);
    }
    expect(logged.join("\n")).not.toContain("pw-secret-1");
  });
});
