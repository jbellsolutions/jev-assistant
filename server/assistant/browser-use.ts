import type { WorkTask } from "../../core/assistant.js";
import type { TaskWorker, WorkContext } from "./tasks.js";

type Run = { id: string; sessionId: string; status: string; result?: string | null; error?: string | null; totalCostUsd?: string };
type CloudEvent = { id: number; type: string; data: Record<string, unknown> };
const ended = new Set(["completed", "failed", "cancelled"]);
export class BrowserUseWorker implements TaskWorker {
  private views = new Map<string, string>();
  constructor(private readonly opts: { key?: string; profileId?: string; workspaceId?: string; proxyCountryCode?: string; record?: boolean; timeoutMs?: number; fetch?: typeof fetch; baseURL?: string; pollMs?: number; maxCostUsd?: string }) {}
  liveView(id: string): string | undefined { return this.views.get(id); }
  private async api<T>(route: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    if (!this.opts.key) throw new Error("Connect Browser Use Cloud in Settings before running cloud tasks.");
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseURL ?? "https://api.browser-use.com/api/v4"}${route}`, {
      method, headers: { "X-Browser-Use-API-Key": this.opts.key, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Browser Use returned HTTP ${res.status}; inspect the existing run before retrying.`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
  async run(task: WorkTask, ctx: WorkContext): Promise<string> {
    if (!this.opts.key) throw new Error("Connect Browser Use Cloud in Settings before running cloud tasks.");
    let run: Run | undefined;
    if (task.providerRunId) {
      run = await this.api<Run>(`/runs/${encodeURIComponent(task.providerRunId)}`, "GET", undefined, ctx.signal);
      // A paused/cancelled run is continued only after an explicit Resume, using its conversation.
      if (run.status === "cancelled") run = undefined;
    } else if (task.dispatching) throw new Error("The previous dispatch outcome is unknown. Reconcile it in Browser Use before creating another run.");
    if (!run) {
      ctx.update({ dispatching: true, progress: "Dispatching cloud task" });
      const prompt = `Work only in this cloud browser. Never switch to a local computer.\nUser request: ${task.goal}\n${task.providerSessionId ? "This is a resumed task. Inspect current state and earlier results first. Do not repeat completed writes." : ""}\nIf an identity, account or material detail is ambiguous, stop and explain what is needed. Return observed results and evidence URLs. A task instruction does not authorize unrelated actions.`;
      run = await this.api<Run>("/runs", "POST", {
        task: prompt, model: "gpt-6-luna", modelParams: { reasoning: { effort: "high" }, service_tier: "default" },
        maxCostUsd: this.opts.maxCostUsd ?? "1.00",
        ...(this.opts.workspaceId ? { workspaceId: this.opts.workspaceId } : {}),
        ...(task.providerSessionId ? { sessionId: task.providerSessionId } : { browserSettings: {
          ...(this.opts.profileId ? { profileId: this.opts.profileId } : {}), proxyCountryCode: this.opts.proxyCountryCode ?? "us", record: this.opts.record ?? false,
        } }),
      }, ctx.signal);
      if (!run.id || !run.sessionId) throw new Error("Browser Use did not acknowledge a valid run; do not retry blindly.");
      ctx.update({ providerRunId: run.id, providerSessionId: run.sessionId, providerCursor: 0, providerBrowserId: undefined, dispatching: false });
    }
    let cursor = task.providerRunId === run.id ? task.providerCursor ?? 0 : 0;
    let browserId = task.providerRunId === run.id ? task.providerBrowserId : undefined;
    const deadlineAt = task.providerRunId === run.id && task.providerDeadlineAt && !ended.has(run.status) ? task.providerDeadlineAt : Date.now() + Math.max(1, this.opts.timeoutMs ?? 15 * 60_000);
    ctx.update({ providerDeadlineAt: deadlineAt });
    const deadline = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
    const signal = AbortSignal.any([ctx.signal, deadline]);
    let terminal = ended.has(run.status);
    try {
      for (;;) {
        signal.throwIfAborted();
        const status = await this.api<{ status: string }>(`/runs/${run.id}/status`, "GET", undefined, signal);
        terminal = ended.has(status.status);
        let more = true;
        while (more) {
          const page = await this.api<{ events: CloudEvent[]; nextAfter?: number; hasMore?: boolean }>(`/runs/${run.id}/events?after=${cursor}&limit=100`, "GET", undefined, signal);
          for (const event of page.events) {
            if (event.id <= cursor) continue;
            cursor = event.id;
            if (typeof event.data.live_view_url === "string" && /^https:\/\//.test(event.data.live_view_url)) this.views.set(task.id, event.data.live_view_url);
            if (typeof event.data.browser_session_id === "string") browserId = event.data.browser_session_id;
            ctx.update({ providerCursor: cursor, ...(browserId ? { providerBrowserId: browserId } : {}), progress: event.type.replace(/[._]/g, " ") });
          }
          more = !!page.hasMore;
          if (more && !page.events.length) throw new Error("Browser Use event cursor did not advance");
        }
        if (ended.has(status.status)) {
          const final = await this.api<Run>(`/runs/${run.id}`, "GET", undefined, signal);
          if (final.status !== "completed") throw new Error(final.error || `Cloud run ${final.status}`);
          if (!final.result?.trim()) throw new Error("The cloud run ended without a result. Review its evidence before considering this task complete.");
          return final.result.trim();
        }
        await new Promise<void>((resolve, reject) => {
          const done = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
          const abort = () => { clearTimeout(timer); reject(new Error(deadline.aborted ? "Cloud task reached its time limit" : "Task interrupted")); };
          const timer = setTimeout(done, this.opts.pollMs ?? 2000);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    } finally {
      this.views.delete(task.id);
      const failures: string[] = [];
      // Cleanup uses its own bounded request signal, even when the task was aborted.
      if (!terminal) await this.api(`/runs/${run.id}/cancel`, "POST").catch(() => failures.push("run cancellation"));
      if (!browserId) {
        await this.api<{ events: CloudEvent[] }>(`/runs/${run.id}/events?after=0&limit=100`).then((page) => {
          for (const event of page.events) if (typeof event.data.browser_session_id === "string") browserId = event.data.browser_session_id;
        }).catch(() => failures.push("browser lookup"));
      }
      if (browserId) await this.api(`/browsers/${browserId}`, "PATCH", { action: "stop" }).catch(() => failures.push("browser shutdown"));
      if (failures.length) {
        ctx.update({ dispatching: true, progress: "Cloud stop is unconfirmed. Reconcile the existing run before resuming." });
        throw new Error(`Could not confirm cloud ${failures.join(" and ")}. Inspect the existing run before retrying.`);
      }
    }
  }
  async cancel(task: WorkTask): Promise<void> {
    if (task.providerRunId) await this.api(`/runs/${task.providerRunId}/cancel`, "POST");
    else if (task.dispatching) throw new Error("Dispatch is not yet acknowledged; reconcile it before continuing");
  }
}
