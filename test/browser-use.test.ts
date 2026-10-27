import { describe, expect, it } from "vitest";
import { BrowserUseWorker } from "../server/assistant/browser-use.js";
import type { WorkContext } from "../server/assistant/tasks.js";
import type { WorkTask } from "../core/assistant.js";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const task = (over: Partial<WorkTask> = {}): WorkTask => ({ id: "task", goal: "Compare pricing", target: "cloud", status: "queued", createdAt: 1, updatedAt: 1, revision: 1, progress: "", output: "", history: [], ...over });
function context() { const patches: Partial<WorkTask>[] = []; return { patches, ctx: { signal: new AbortController().signal, update: (p: Partial<WorkTask>) => patches.push(p), event() {} } satisfies WorkContext }; }
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

describe("Browser Use V4 worker", () => {
  it("finds its viewer from the acknowledged session when no browser-ready event is available", async () => {
    const stopped: string[] = [];
    const w = new BrowserUseWorker({ key: "key", retainBrowser: true, fetch: async (url, init) => {
      const u = new URL(String(url)), p = u.pathname;
      if (p.endsWith("/runs")) return json({ id: "run", sessionId: "acknowledged-session", status: "running" });
      if (p.endsWith("/status")) return json({ status: "completed" });
      if (p.endsWith("/events")) return json({ events: [] });
      if (p.endsWith("/browsers")) { expect(u.searchParams.get("agentSessionId")).toBe("acknowledged-session"); return json({ items: [{ id: "foreign", agentSessionId: "another-session", status: "active", liveUrl: "https://view.example/foreign" }, { id: "owned", agentSessionId: "acknowledged-session", status: "active", liveUrl: "https://view.example/owned" }] }); }
      if (p.includes("/browsers/")) { stopped.push(p); return json({}); }
      return json({ status: "completed", result: "Done" });
    } });
    await w.run(task(), context().ctx); expect(w.browserView().url).toBe("https://view.example/owned");
    await w.closeBrowser(); expect(stopped).toEqual(["/api/v4/browsers/owned"]);
  });
  it("keeps the interactive browser for follow-up tasks, reuses its session and explicitly stops it", async () => {
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = []; let runs = 0;
    const w = new BrowserUseWorker({ key: "key", retainBrowser: true, fetch: async (url, init) => {
      const p = new URL(String(url)).pathname; const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path: p, body });
      if (p.endsWith("/runs")) return json({ id: `run-${++runs}`, sessionId: "shared-session", status: "running" });
      if (p.endsWith("/status")) return json({ status: "completed" });
      if (p.endsWith("/events")) return json({ events: [{ id: 1, type: "browser.ready", data: { browser_session_id: "owned", live_view_url: "https://view.example/private" } }] });
      return json({ status: "completed", result: "Done" });
    } });
    await w.run(task(), context().ctx); expect(w.browserView().url).toBe("https://view.example/private");
    expect(calls.filter((c) => c.body?.action === "stop")).toHaveLength(0);
    await w.run(task({ id: "followup" }), context().ctx);
    expect(calls.filter((c) => c.path.endsWith("/runs")).map((c) => c.body)).toEqual([expect.objectContaining({ keepAlive: 900 }), expect.objectContaining({ sessionId: "shared-session", keepAlive: 900 })]);
    await w.closeBrowser(); expect(w.browserView().url).toBeNull();
    expect(calls.filter((c) => c.body?.action === "stop")).toHaveLength(1);
  });
  it("never keeps a failed cloud run's browser alive", async () => {
    let stopped = false;
    const w = new BrowserUseWorker({ key: "key", retainBrowser: true, fetch: async (url, init) => {
      const p = new URL(String(url)).pathname;
      if (p.endsWith("/runs")) return json({ id: "run", sessionId: "session", status: "running" });
      if (p.endsWith("/status")) return json({ status: "failed" });
      if (p.endsWith("/events")) return json({ events: [{ id: 1, type: "browser.ready", data: { browserId: "owned", liveUrl: "https://view.example/private" } }] });
      if (p.includes("/browsers/")) { stopped = true; return json({}); }
      return json({ status: "failed", error: "Stopped by provider" });
    } });
    await expect(w.run(task(), context().ctx)).rejects.toThrow("Stopped by provider");
    expect(stopped).toBe(true); expect(w.browserView().url).toBeNull();
  });
  it("recovers only its journaled browsers after a process crash, retaining a resumable active run", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "jarvis-cloud-")); const browserId = "00000000-0000-4000-8000-000000000000";
    const stopped: string[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      const p = new URL(String(url)).pathname;
      if (p.endsWith("/runs")) return json({ id: "run", sessionId: "session", status: "running" });
      if (p.endsWith("/status")) return json({ status: "completed" });
      if (p.endsWith("/events")) return json({ events: [{ id: 1, type: "browser.ready", data: { browser_session_id: browserId, live_view_url: "https://view.example/private" } }] });
      if (p.includes("/browsers/")) { if (init?.method === "PATCH") stopped.push(p); return json({ status: "active", liveUrl: "https://view.example/private" }); }
      return json({ status: "completed", result: "Done" });
    };
    try {
      await new BrowserUseWorker({ key: "key", retainBrowser: true, home, fetch: fetcher }).run(task(), context().ctx);
      expect(JSON.parse(readFileSync(path.join(home, "cloud-browsers.json"), "utf8"))).toEqual([browserId]);
      expect(statSync(path.join(home, "cloud-browsers.json")).mode & 0o777).toBe(0o600);
      const active = new BrowserUseWorker({ key: "key", retainBrowser: true, home, fetch: fetcher }); await active.recover([browserId]); expect(stopped).toEqual([]);
      const restarted = new BrowserUseWorker({ key: "key", retainBrowser: true, home, fetch: fetcher }); await restarted.recover();
      expect(stopped).toEqual([`/api/v4/browsers/${browserId}`]); expect(JSON.parse(readFileSync(path.join(home, "cloud-browsers.json"), "utf8"))).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it("pins Luna, persists the dispatch receipt, drains terminal events and releases the owned browser", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      const p = new URL(String(url)).pathname; calls.push({ path: p, init });
      if (p.endsWith("/runs")) return json({ id: "run", sessionId: "session", status: "running" });
      if (p.endsWith("/status")) return json({ status: "completed" });
      if (p.endsWith("/events")) return json({ events: [{ id: 1, type: "browser.ready", data: { browser_session_id: "owned", live_view_url: "https://view.example/session" } }], hasMore: false });
      if (p.endsWith("/runs/run")) return json({ id: "run", sessionId: "session", status: "completed", result: "Pricing source: https://example.com/pricing" });
      return json({ ok: true });
    };
    const w = new BrowserUseWorker({ key: "test-key", fetch: fetcher, workspaceId: "workspace", profileId: "profile" }); const c = context();
    expect(await w.run(task(), c.ctx)).toContain("https://example.com/pricing");
    const body = JSON.parse(String(calls[0]!.init!.body)); expect(body.model).toBe("gpt-6-luna"); expect(body.maxCostUsd).toBe("1.00");
    expect(body).toMatchObject({ workspaceId: "workspace", browserSettings: { profileId: "profile", proxyCountryCode: "us", record: false }, modelParams: { reasoning: { effort: "high" }, service_tier: "default" } });
    expect(c.patches).toContainEqual(expect.objectContaining({ providerRunId: "run", providerSessionId: "session", dispatching: false }));
    expect(calls.findIndex((c) => c.path.endsWith("/status"))).toBeLessThan(calls.findIndex((c) => c.path.endsWith("/events")));
    expect(calls.at(-1)).toMatchObject({ path: "/api/v4/browsers/owned", init: { method: "PATCH", body: JSON.stringify({ action: "stop" }) } });
    expect(w.liveView("task")).toBeUndefined();
  });
  it("reconciles an existing completed run without another dispatch", async () => {
    const methods: string[] = [];
    const w = new BrowserUseWorker({ key: "key", fetch: async (url, init) => {
      methods.push(init?.method ?? "GET");
      if (String(url).includes("/status")) return json({ status: "completed" });
      if (String(url).includes("/events")) return json({ events: [], hasMore: false });
      return json({ id: "run", sessionId: "session", status: "completed", result: "Already done" });
    } });
    expect(await w.run(task({ providerRunId: "run" }), context().ctx)).toBe("Already done"); expect(methods.every((m) => m === "GET")).toBe(true);
  });
  it("leaves an uncertain dispatch marked and never automatically retries POST", async () => {
    let attempts = 0; const w = new BrowserUseWorker({ key: "key", fetch: async () => { attempts++; throw new Error("lost acknowledgement"); } });
    const c = context(); await expect(w.run(task(), c.ctx)).rejects.toThrow(/lost acknowledgement/);
    expect(attempts).toBe(1); expect(c.patches[0]).toMatchObject({ dispatching: true });
    await expect(w.run(task({ dispatching: true }), c.ctx)).rejects.toThrow(/unknown/); expect(attempts).toBe(1);
  });
  it("sends an actual remote cancellation", async () => {
    const calls: string[] = []; const w = new BrowserUseWorker({ key: "key", fetch: async (url, init) => { calls.push(`${init?.method} ${url}`); return json({ status: "cancelled" }); } });
    await w.cancel(task({ providerRunId: "run" })); expect(calls).toEqual(["POST https://api.browser-use.com/api/v4/runs/run/cancel"]);
  });
  it("cancels a timed-out run and still releases its saved browser", async () => {
    const calls: string[] = []; const w = new BrowserUseWorker({ key: "key", pollMs: 1000, timeoutMs: 10, fetch: async (url, init) => {
      const p = new URL(String(url)).pathname; calls.push(`${init?.method} ${p}`);
      if (p.endsWith("/runs")) return json({ id: "run", sessionId: "session", status: "running" });
      if (p.endsWith("/status")) return json({ status: "running" });
      if (p.endsWith("/events")) return json({ events: [{ id: 1, type: "browser.ready", data: { browser_session_id: "owned" } }] });
      return new Response(null, { status: 204 });
    } });
    const c = context(); await expect(w.run(task(), c.ctx)).rejects.toThrow(/time limit/);
    expect(c.patches).toContainEqual(expect.objectContaining({ providerBrowserId: "owned" }));
    expect(calls.slice(-2)).toEqual(["POST /api/v4/runs/run/cancel", "PATCH /api/v4/browsers/owned"]);
  });
  it("reports cleanup failure instead of claiming success", async () => {
    const w = new BrowserUseWorker({ key: "key", fetch: async (url) => {
      const p = String(url);
      if (p.includes("/browsers/")) return json({}, 503);
      if (p.includes("/events")) return json({ events: [] });
      if (p.includes("/status")) return json({ status: "completed" });
      return json({ id: "run", sessionId: "session", status: "completed", result: "Done" });
    } });
    await expect(w.run(task({ providerRunId: "run", providerBrowserId: "owned" }), context().ctx)).rejects.toThrow(/Could not confirm cloud browser shutdown/);
  });
  it("refuses work without a cloud key", async () => { await expect(new BrowserUseWorker({}).run(task(), context().ctx)).rejects.toThrow(/Connect Browser Use/); });
});
