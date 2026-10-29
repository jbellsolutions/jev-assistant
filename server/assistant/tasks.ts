import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkTask, WorkTarget } from "../../core/assistant.js";
import type { ApprovalChoice, BrainEvent } from "../../core/brain.js";

export interface WorkContext {
  signal: AbortSignal;
  update(patch: Partial<WorkTask>): void;
  event(event: BrainEvent): void;
}
export interface TaskWorker {
  run(task: WorkTask, ctx: WorkContext): Promise<string | { output: string; status: "completed" | "paused"; progress?: string }>;
  approve?(id: string, choice: ApprovalChoice, requestId: string | null): Promise<void>;
  cancel?(task: WorkTask): Promise<void>;
}
const terminal = new Set(["completed", "failed", "cancelled"]);
export class TaskQueue {
  private tasks = new Map<string, WorkTask>();
  private requests = new Map<string, string>();
  private listeners = new Set<() => void>();
  private active: { id: string; ctrl: AbortController } | null = null;
  private closed = false;
  private enabled = true;
  private execution: Promise<void> | null = null;
  private lockFile: string;
  constructor(private readonly opts: { dir: string; workers: Record<WorkTarget, TaskWorker>; now?: () => number; pauseQueuedAtStartup?: boolean }) {
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    this.lockFile = path.join(opts.dir, ".owner");
    const takeLock = () => { const fd = openSync(this.lockFile, "wx", 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); };
    try { takeLock(); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(this.lockFile, "utf8"));
      let alive = true;
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("The task lock is invalid. Review it before starting another companion.");
      try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
      if (alive) throw new Error("Another Jev companion is already using this task home. Close it before starting another.");
      rmSync(this.lockFile); takeLock();
    }
    for (const name of readdirSync(opts.dir).filter((s) => s.endsWith(".json"))) {
      let task: WorkTask;
      try { task = JSON.parse(readFileSync(path.join(opts.dir, name), "utf8")); } catch { continue; }
      if (!task || typeof task.id !== "string" || !/^[a-f0-9-]{36}$/.test(task.id) || name !== `${task.id}.json` || !["local", "cloud", "orgo"].includes(task.target) || !Array.isArray(task.history)) continue;
      this.tasks.set(task.id, task);
      if (task.requestId) this.requests.set(task.requestId, task.id);
      if (opts.pauseQueuedAtStartup && task.status === "queued" && !task.providerRunId) this.patch(task.id, { status: "paused", approval: undefined, progress: "Saved task paused after restart. Resume to review its current state." });
      if (["running", "waiting_for_user"].includes(task.status)) {
        this.patch(task.id, task.target === "cloud" && task.providerRunId
          ? { status: "queued", approval: undefined, progress: "Reconnecting to the existing cloud run" }
          : { status: "paused", approval: undefined, progress: "Interrupted at restart. Review the current state before resuming." });
      }
    }
  }
  list(): WorkTask[] { return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt).map((t) => structuredClone(t)); }
  executing(target: WorkTarget): boolean { return !!this.active && this.tasks.get(this.active.id)?.target === target; }
  get(id: string): WorkTask { const t = this.tasks.get(id); if (!t) throw new Error("Task not found"); return structuredClone(t); }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  start(): void { this.kick(); }
  async settled(id: string): Promise<void> { if (this.active?.id === id) await this.execution; }
  setEnabled(enabled: boolean, pauseActive = true): void { this.enabled = enabled; if (enabled) this.kick(); else if (pauseActive && this.active) void this.control(this.active.id, "pause"); }
  submit(goal: string, target: WorkTarget, requestId?: string, attachments?: WorkTask["attachments"]): WorkTask {
    if (this.closed) throw new Error("Task service is shutting down");
    goal = goal.trim();
    if (!goal || goal.length > 12000) throw new Error("Give a task between 1 and 12,000 characters");
    if (requestId && this.requests.has(requestId)) return this.get(this.requests.get(requestId)!);
    if (this.list().filter((t) => !terminal.has(t.status)).length >= 50) throw new Error("The queue is full; finish or cancel a task first");
    const at = this.now();
    const t: WorkTask = { id: randomUUID(), goal, target, status: "queued", revision: 1, createdAt: at, updatedAt: at, progress: "Queued", output: "", history: [], ...(requestId ? { requestId } : {}), ...(attachments?.length ? { attachments } : {}) };
    this.tasks.set(t.id, t);
    if (requestId) this.requests.set(requestId, t.id);
    this.patch(t.id, {});
    this.kick();
    return this.get(t.id);
  }
  async approve(id: string, choice: ApprovalChoice, requestId: string | null): Promise<void> {
    const t = this.get(id);
    if (t.status !== "waiting_for_user" || !t.approval || t.approval.requestId !== requestId || this.active?.id !== id) throw new Error("That approval is no longer pending");
    // A task-scoped approval only; never persist broad grants from a voice interpretation.
    if (!["once", "deny"].includes(choice)) throw new Error("Choose allow once or deny");
    await this.opts.workers[t.target].approve?.(id, choice, requestId);
    const after = this.get(id);
    if (after.status === "waiting_for_user" && after.approval?.requestId === requestId) this.patch(id, { status: "running", approval: undefined, progress: choice === "deny" ? "Action declined" : "Continuing" });
  }
  async control(id: string, action: "pause" | "resume" | "cancel", correction?: string): Promise<void> {
    let t = this.get(id);
    if (terminal.has(t.status) && action !== "resume") return;
    if (action === "resume") {
      if (!["paused", "failed"].includes(t.status)) throw new Error("Pause the task before changing or resuming it");
      if (t.dispatching) throw new Error("Cloud dispatch or stop was uncertain. Reconcile it in Browser Use before starting another run.");
      if (t.providerRunId && t.status === "failed") throw new Error("Review the failed cloud run before starting a new task");
      const patch: Partial<WorkTask> = { status: "queued", error: undefined, approval: undefined, progress: "Queued to resume after checking current state" };
      if (correction?.trim()) { patch.goal = `${t.goal}\n\nCorrection: ${correction.trim().slice(0, 4000)}`; patch.revision = t.revision + 1; }
      this.patch(id, patch); this.kick(); return;
    }
    // Abort local execution before contacting a remote cancel endpoint.
    if (this.active?.id === id) this.active.ctrl.abort();
    this.patch(id, { status: action === "pause" ? "paused" : "cancelled", approval: undefined, progress: action === "pause" ? "Pausing; checking in-flight actions" : "Cancelling; checking in-flight actions" });
    try { await this.opts.workers[t.target].cancel?.(this.get(id)); }
    catch { this.patch(id, { progress: "Remote stop is unconfirmed. Check the provider before resuming.", dispatching: true }); throw new Error("Remote stop is unconfirmed; do not duplicate this task"); }
    t = this.get(id);
    this.patch(id, { progress: action === "pause" ? "Paused. Resume checks what already happened." : "Cancelled. Actions already completed may remain." });
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.active) await this.control(this.active.id, "pause").catch(() => {});
    await this.execution;
    rmSync(this.lockFile, { force: true });
  }
  private now() { return this.opts.now?.() ?? Date.now(); }
  private patch(id: string, patch: Partial<WorkTask>): void {
    const t = this.tasks.get(id)!;
    Object.assign(t, patch, { updatedAt: this.now() });
    if (patch.progress && t.history.at(-1)?.text !== patch.progress) t.history = [...t.history, { at: t.updatedAt, text: patch.progress }].slice(-100);
    const file = path.join(this.opts.dir, `${id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(t, null, 2), { mode: 0o600 }); renameSync(`${file}.tmp`, file);
    for (const fn of this.listeners) fn();
  }
  private kick(): void {
    if (this.active || this.closed || !this.enabled) return;
    const task = [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt).find((t) => t.status === "queued");
    if (!task) return;
    const ctrl = new AbortController(); this.active = { id: task.id, ctrl };
    this.execution = this.execute(structuredClone(task), ctrl).finally(() => { this.active = null; this.execution = null; this.kick(); });
  }
  private async execute(task: WorkTask, ctrl: AbortController): Promise<void> {
    this.patch(task.id, { status: "running", progress: "Starting", error: undefined });
    try {
      const result = await this.opts.workers[task.target].run(task, {
        signal: ctrl.signal,
        update: (p) => this.patch(task.id, p),
        event: (e) => {
          if (ctrl.signal.aborted) return;
          if (e.kind === "approval") this.patch(task.id, { status: "waiting_for_user", approval: { summary: e.summary, requestId: e.requestId }, progress: "Waiting for your approval" });
          if (e.kind === "tool_start") this.patch(task.id, { progress: `Using ${e.tool}: ${e.preview.slice(0, 200)}` });
          if (e.kind === "delta") this.patch(task.id, { output: (this.tasks.get(task.id)!.output + e.text).slice(-20000) });
          if (e.kind === "say") this.patch(task.id, { progress: e.text });
        },
      });
      const output = typeof result === "string" ? result : result.output;
      if (!ctrl.signal.aborted) this.patch(task.id, { status: typeof result === "string" ? "completed" : result.status, output, approval: undefined, progress: typeof result === "string" ? "Worker finished — review the result and evidence" : result.progress || "Worker finished — review the result and evidence" });
    } catch (err) {
      if (!ctrl.signal.aborted) this.patch(task.id, { status: "failed", approval: undefined, error: err instanceof Error ? err.message : "Task failed", progress: "Task needs attention" });
    }
  }
}
