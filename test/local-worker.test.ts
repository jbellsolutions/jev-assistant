import { describe, expect, it } from "vitest";
import { LocalWorker, workerEnvironment } from "../server/assistant/local-worker.js";
import { CAP_LINE, createAgentBrain } from "../server/brain/agent.js";
import { FakeBrain, waitFor } from "./helpers/fake-brain.js";
import type { WorkTask } from "../core/assistant.js";
import type { BrainEvent } from "../core/brain.js";
import { FakeExecutor } from "./helpers/fake-executor.js";
const task: WorkTask = { id: "task", goal: "Use my Chrome", target: "local", status: "running", progress: "Resuming", revision: 2, createdAt: 1, updatedAt: 1, output: "Earlier observation", history: [{ at: 1, text: "Opened the correct workspace" }] };
const hands = { mac: null, chrome: null, computer: null };
describe("local Luna worker", () => {
  it("inspects the real Mac surface before answering a phone visibility request", async () => {
    const brain = new FakeBrain(), mac = new FakeExecutor([]); const sensitive = "syntheticCredentialValue1234567890"; mac.titleText = `Actual Mac window · API key: ${sensitive}`;
    const w = new LocalWorker({ env: {}, hands: { ...hands, mac }, createBrain: () => brain });
    const result = w.run({ ...task, goal: "Can you see my Mac now?" }, { signal: new AbortController().signal, event() {}, update() {} });
    await waitFor(() => brain.sent.length === 1);
    expect(mac.snapshots).toBe(1); expect(brain.sent[0]).toContain("Actual Mac window"); expect(brain.sent[0]).toContain("Fresh Mac observation");
    expect(brain.sent[0]).not.toContain(sensitive); expect(brain.sent[0]).toContain("[hidden credential;");
    brain.emit("run_1", { kind: "completed", output: "I inspected the connected Mac." }, null); await result;
  });
  it("restricts Orgo to its own tools and removes Orgo from local work", () => {
    const remote = workerEnvironment("orgo", hands); expect(remote.hands.chrome).toBeNull(); expect(remote.hands.mac).toBeNull(); expect(remote.ownTools).toEqual(["orgo"]);
    const local = workerEnvironment("local", hands); expect(local.hands.orgo).toBeNull(); expect(local.ownTools).not.toContain("orgo"); expect(local.ownTools).not.toContain("cofounder");
  });
  it("requires the requested provider and does not silently use another account", async () => {
    const w = new LocalWorker({ env: { OPENROUTER_API_KEY: "old-key" }, hands });
    await expect(w.run(task, { signal: new AbortController().signal, event() {}, update() {} })).rejects.toThrow(/OpenAI/);
  });
  it("configures direct OpenAI Responses with the requested Luna model without a live call", async () => {
    const b = createAgentBrain({ OPENAI_API_KEY: "fake-key" }, { hands, apps: null });
    expect(b!.modelId).toBe("gpt-6-luna"); expect((await b!.health()).detail).toContain("via OpenAI");
  });
  it("carries saved observations, forwards approval and keeps the final result", async () => {
    const brain = new FakeBrain(); const w = new LocalWorker({ env: {}, hands, createBrain: () => brain });
    const events: BrainEvent[] = [];
    const result = w.run(task, { signal: new AbortController().signal, event: (e) => events.push(e), update() {} });
    await waitFor(() => brain.sent.length === 1);
    expect(brain.sent[0]).toContain("Opened the correct workspace"); expect(brain.sent[0]).toContain("Earlier observation");
    brain.emit("run_1", { kind: "approval", requestId: "specific", summary: "Send message", choices: ["once", "deny"] });
    await w.approve(task.id, "once", "specific");
    expect(brain.approvals[0]).toMatchObject({ runId: "run_1", requestId: "specific", choice: "once" });
    brain.emit("run_1", { kind: "completed", output: "Observed message ID 123" }, null);
    expect(await result).toBe("Observed message ID 123"); expect(events.some((e) => e.kind === "approval")).toBe(true);
  });
  it("pauses partial work at the step cap instead of claiming completion", async () => {
    const brain = new FakeBrain(); const w = new LocalWorker({ env: {}, hands, createBrain: () => brain });
    const result = w.run(task, { signal: new AbortController().signal, event() {}, update() {} });
    await waitFor(() => brain.sent.length === 1); brain.emit("run_1", { kind: "completed", output: CAP_LINE }, null);
    expect(await result).toMatchObject({ status: "paused", output: CAP_LINE });
  });
});
