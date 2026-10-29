import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HeuristicDecider } from "../core/decide.js";
import { createCompanion, type Companion } from "../server/companion.js";
import { createAssistantRuntime } from "../server/assistant/runtime.js";
import type { TaskWorker } from "../server/assistant/tasks.js";
import { FakeExecutor } from "./helpers/fake-executor.js";
let companion: Companion | undefined;
let home: string | undefined;
async function boot(workers?: { local: TaskWorker }) {
  home = mkdtempSync(path.join(tmpdir(), "jev-assistant-http-"));
  const assistant = createAssistantRuntime({ env: { JEV_HOME: home }, hands: { mac: null, chrome: null, computer: null }, chromeReady: () => false, computerReady: () => false, workers });
  companion = createCompanion({ token: "private-token", decider: new HeuristicDecider(), assistant });
  const port = await companion.listen(0); companion.register(new FakeExecutor([], "chrome"));
  const base = `http://127.0.0.1:${port}`;
  const call = (route: string, body?: unknown, headers: Record<string, string> = { authorization: "Bearer private-token" }) => fetch(`${base}/assistant${route}`, { method: body === undefined ? "GET" : "POST", headers: { ...headers, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { assistant, call, base };
}
afterEach(async () => { await companion?.close(); companion = undefined; if (home) rmSync(home, { recursive: true, force: true }); });
describe("assistant local boundary", () => {
  it("rejects foreign web origins and unauthenticated local scripts", async () => {
    const { call, base } = await boot();
    expect((await call("/status", undefined, {})).status).toBe(401);
    expect((await call("/status", undefined, { "X-Jev-UI": "1", origin: "https://other.example" })).status).toBe(401);
    expect((await call("/status", undefined, { "X-Jev-UI": "1", origin: base })).status).toBe(200);
    expect((await call("/status")).status).toBe(200);
  });
  it("enables requested-work permissions independently of optional app accounts and persists changes", async () => {
    const { call } = await boot();
    expect(await (await call("/permissions")).json()).toEqual({ enabled: true });
    expect((await call("/permissions", { enabled: false }, { "X-Jev-UI": "1", origin: "https://foreign.example" })).status).toBe(401);
    expect(await (await call("/permissions")).json()).toEqual({ enabled: true });
    expect(await (await call("/permissions", { enabled: false })).json()).toEqual({ ok: true, enabled: false });
    expect(await (await call("/permissions")).json()).toEqual({ enabled: false });
    const blocked = await call("/command", { text: "Open a page", target: "cloud" });
    expect(blocked.status).toBe(400); expect((await blocked.json()).error).toContain("Enable permissions");
    expect(await (await call("/permissions", { enabled: true })).json()).toEqual({ ok: true, enabled: true });
  });
  it("turning permissions off interrupts active work and pauses the queue", async () => {
    let started!: () => void; const running = new Promise<void>(resolve => { started = resolve; });
    const { assistant, call } = await boot({ local: { run: async (_task, ctx) => { started(); await new Promise<void>(resolve => ctx.signal.addEventListener("abort", () => resolve(), { once: true })); throw new Error("interrupted"); } } });
    await call("/command", { text: "Test active work", target: "local" }); await running;
    await call("/command", { text: "A separate next task", target: "local" });
    const response = await call("/permissions", { enabled: false });
    expect(response.status).toBe(200);
    expect(assistant.queue.list().every(t => t.status === "paused")).toBe(true);
    const task = assistant.queue.list()[0]!;
    expect((await call(`/tasks/${task.id}/control`, { action: "resume" })).status).toBe(400);
    expect((await call("/browser/open", {})).status).toBe(400);
    assistant.setPaused(true); assistant.setPaused(false);
    expect(assistant.queue.list().every(t => t.status === "paused")).toBe(true);
    expect((await call("/command", { text: "What is the task status?", target: "local" })).status).toBe(200);
  });
  it("reports missing connections without leaking environment values and refuses live voice", async () => {
    const { call } = await boot(); const status = await (await call("/status")).json();
    expect(status.connections).toMatchObject({ openai: false, livekit: false, chrome: false });
    expect(JSON.stringify(status)).not.toContain("private-token");
    const res = await call("/voice/token", { target: "local" }); expect(res.status).toBe(400); expect((await res.json()).error).toContain("credentials");
  });
  it("saves a local request and reports missing model setup honestly", async () => {
    const { call, assistant } = await boot();
    const res = await call("/command", { text: "Send Xander the requested message", target: "local", requestId: "request" });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(assistant.queue.list()[0]).toMatchObject({ status: "failed", target: "local" });
    expect(assistant.queue.list()[0]!.error).toContain("OpenAI");
  });
  it("global pause prevents new tasks through both HTTP and voice dispatch", async () => {
    const { call } = await boot(); companion!.hub.setPaused(true);
    const res = await call("/command", { text: "Work", target: "local" }); expect(res.status).toBe(400); expect((await res.json()).error).toMatch(/paused/);
  });
});
