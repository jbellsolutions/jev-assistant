import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskQueue, type TaskWorker, type WorkContext } from "../server/assistant/tasks.js";
import type { WorkTask } from "../core/assistant.js";

const dirs: string[] = [];
const queues: TaskQueue[] = [];
const temp = () => { const d = mkdtempSync(path.join(tmpdir(), "jev-work-test-")); dirs.push(d); return d; };
const done: TaskWorker = { run: async () => "Verified result" };
function queue(local: TaskWorker = done, cloud: TaskWorker = done, dir = temp()) { const q = new TaskQueue({ dir, workers: { local, cloud, orgo: local } }); queues.push(q); return { q, dir }; }
function held() {
  const starts: string[] = [];
  const finish = new Map<string, (output: string) => void>();
  const contexts = new Map<string, WorkContext>();
  const worker: TaskWorker = { run: (t, ctx) => {
    starts.push(t.id); contexts.set(t.id, ctx);
    return new Promise((resolve, reject) => { finish.set(t.id, resolve); ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
  }, cancel: vi.fn(async () => {}) };
  return { worker, starts, finish, contexts };
}
afterEach(async () => { for (const q of queues.splice(0)) await q.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("saved task execution", () => {
  it("leaves previously queued, undispatched work paused for review when startup recovery requests it", async () => {
    const w = held(); const { q, dir } = queue(w.worker);
    q.submit("Active before restart", "local"); const pending = q.submit("Old undelivered request", "cloud");
    await q.close(); queues.splice(queues.indexOf(q), 1);
    const fresh = held(); const next = new TaskQueue({ dir, workers: { local: fresh.worker, cloud: fresh.worker, orgo: fresh.worker }, pauseQueuedAtStartup: true }); queues.push(next);
    next.start(); expect(next.get(pending.id).status).toBe("paused"); expect(fresh.starts).toEqual([]);
    await next.control(pending.id, "resume"); expect(fresh.starts).toEqual([pending.id]);
  });
  it("serializes local and cloud work through one queue", async () => {
    const w = held(); const { q } = queue(w.worker, w.worker);
    const a = q.submit("First", "local"); const b = q.submit("Second", "cloud");
    expect(w.starts).toEqual([a.id]); expect(q.get(b.id).status).toBe("queued");
    w.finish.get(a.id)!("one"); await vi.waitFor(() => expect(w.starts).toEqual([a.id, b.id]));
    w.finish.get(b.id)!("two"); await vi.waitFor(() => expect(q.get(b.id).status).toBe("completed"));
  });
  it("persists results privately and deduplicates a delivery across restart", async () => {
    const { q, dir } = queue(); const a = q.submit("Read the page", "local", "delivery-1");
    await vi.waitFor(() => expect(q.get(a.id).status).toBe("completed"));
    expect(q.submit("Read the page", "local", "delivery-1").id).toBe(a.id);
    expect(statSync(path.join(dir, `${a.id}.json`)).mode & 0o777).toBe(0o600);
    await q.close(); queues.splice(queues.indexOf(q), 1);
    const next = queue(done, done, dir).q;
    expect(next.submit("Read the page", "local", "delivery-1").id).toBe(a.id);
    expect(next.get(a.id).output).toBe("Verified result");
  });
  it("retains local work as paused after interruption and applies a correction before resuming", async () => {
    const w = held(); const { q, dir } = queue(w.worker);
    const a = q.submit("Check Slack", "local"); await q.close(); queues.splice(queues.indexOf(q), 1);
    const nextWorker = held(); const next = queue(nextWorker.worker, done, dir).q;
    expect(next.get(a.id).status).toBe("paused");
    await next.control(a.id, "resume", "Use Xander in the partner workspace");
    expect(next.get(a.id).goal).toContain("Correction: Use Xander"); expect(next.get(a.id).revision).toBe(2);
  });
  it("reconnects an acknowledged cloud run but blocks redispatch when acknowledgement was lost", async () => {
    const w = held(); const { q, dir } = queue(done, w.worker);
    const a = q.submit("Cloud research", "cloud");
    w.contexts.get(a.id)!.update({ providerRunId: "existing-run", providerSessionId: "session" });
    await q.close(); queues.splice(queues.indexOf(q), 1);
    const file = path.join(dir, `${a.id}.json`); const saved: WorkTask = JSON.parse(readFileSync(file, "utf8")); saved.status = "running"; writeFileSync(file, JSON.stringify(saved));
    const nextW = held(); const next = queue(done, nextW.worker, dir).q;
    expect(next.get(a.id).status).toBe("queued"); next.start();
    expect(next.get(a.id).providerRunId).toBe("existing-run");
    nextW.contexts.get(a.id)!.update({ dispatching: true }); await next.control(a.id, "pause");
    await expect(next.control(a.id, "resume")).rejects.toThrow(/uncertain/);
  });
  it("binds approvals to the current task and request and refuses broad grants", async () => {
    const w = held(); w.worker.approve = vi.fn(async () => {});
    const { q } = queue(w.worker); const a = q.submit("Send the message", "local");
    w.contexts.get(a.id)!.event({ kind: "approval", requestId: "new-request", summary: "Send to Xander", choices: ["once", "deny"] });
    await expect(q.approve(a.id, "once", "stale-request")).rejects.toThrow(/no longer pending/);
    await expect(q.approve(a.id, "always", "new-request")).rejects.toThrow(/once/);
    await q.approve(a.id, "once", "new-request"); expect(w.worker.approve).toHaveBeenCalledWith(a.id, "once", "new-request");
  });
  it("cancels the active worker without resurrecting its terminal result", async () => {
    const w = held(); const { q } = queue(w.worker); const a = q.submit("Work", "local");
    await q.control(a.id, "cancel"); expect(w.worker.cancel).toHaveBeenCalled();
    await vi.waitFor(() => expect(q.get(a.id).status).toBe("cancelled"));
  });
  it("keeps a failed worker honest and never substitutes another environment", async () => {
    const local = { run: vi.fn(async () => { throw new Error("Chrome disconnected"); }) }; const cloud = { run: vi.fn(async () => "wrong") };
    const { q } = queue(local, cloud); const a = q.submit("Use my Chrome", "local");
    await vi.waitFor(() => expect(q.get(a.id).status).toBe("failed")); expect(cloud.run).not.toHaveBeenCalled();
    expect(q.get(a.id).error).toBe("Chrome disconnected");
  });
  it("does not let a second companion mutate the same task home", async () => {
    const { dir } = queue(); expect(() => new TaskQueue({ dir, workers: { local: done, cloud: done, orgo: done } })).toThrow(/already using/);
  });
});
