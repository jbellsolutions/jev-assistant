import type { WorkTask } from "../../core/assistant.js";
import type { TaskWorker, WorkContext } from "./tasks.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

type Run = { id: string; sessionId: string; status: string; result?: string | null; error?: string | null; totalCostUsd?: string };
type CloudEvent = { id: number; type: string; data: Record<string, unknown> };
const ended = new Set(["completed", "failed", "cancelled"]);
export class BrowserUseWorker implements TaskWorker {
  private views = new Map<string, string>();
  private retained?: { sessionId: string; browserId: string; url: string; expiresAt: number; taskId: string };
  private owned = new Set<string>();
  private inherited = new Set<string>();
  private journal?: string;
  private recovery: Promise<void> | null = null;
  private checkedAt = 0;
  private candidate?: { sessionId: string; taskId: string; expiresAt: number };
  constructor(private readonly opts: { key?: string; profileId?: string; workspaceId?: string; proxyCountryCode?: string; record?: boolean; timeoutMs?: number; fetch?: typeof fetch; baseURL?: string; pollMs?: number; maxCostUsd?: string; retainBrowser?: boolean; home?: string }) {
    if (opts.home) { mkdirSync(opts.home, { recursive: true, mode: 0o700 }); this.journal = path.join(opts.home, "cloud-browsers.json");
      try { const saved: unknown = JSON.parse(readFileSync(this.journal, "utf8")); if (Array.isArray(saved)) for (const id of saved) if (typeof id === "string" && /^[a-f0-9-]{36}$/.test(id)) { this.owned.add(id); this.inherited.add(id); } } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cloud browser recovery data could not be read"); }
    }
  }
  private save() { if (this.journal) { writeFileSync(`${this.journal}.tmp`, JSON.stringify([...this.owned]), { mode: 0o600 }); renameSync(`${this.journal}.tmp`, this.journal); } }
  browserView() { return this.retained && this.retained.expiresAt > Date.now() ? { url: this.retained.url, taskId: this.retained.taskId, expiresAt: this.retained.expiresAt } : { url: null }; }
  async inspectView() {
    if (!this.retained && this.candidate && this.candidate.expiresAt > Date.now()) await this.lookupView(this.candidate.taskId, this.candidate.sessionId);
    const current = this.retained;
    if (current && Date.now() - this.checkedAt > 15000) {
      this.checkedAt = Date.now();
      const browser = await this.api<{ status: string; liveUrl?: string | null }>(`/browsers/${encodeURIComponent(current.browserId)}`);
      if (browser.status === "stopped") { this.owned.delete(current.browserId); this.save(); if (this.retained === current) this.retained = undefined; }
      else if (browser.liveUrl?.startsWith("https://")) current.url = browser.liveUrl;
    }
    return this.browserView();
  }
  private async lookupView(taskId: string, sessionId: string, signal?: AbortSignal): Promise<string | undefined> {
    const page = await this.api<{ items?: Array<{ id: string; agentSessionId?: string; status: string; liveUrl?: string | null }> }>(`/browsers?agentSessionId=${encodeURIComponent(sessionId)}&filterBy=active&pageSize=100`, "GET", undefined, signal);
    const matches = page.items?.filter((b) => b.agentSessionId === sessionId && b.status === "active") ?? [];
    if (matches.length !== 1) return;
    const browser = matches[0]!; this.owned.add(browser.id); this.save();
    if (browser.liveUrl?.startsWith("https://")) {
      this.views.set(taskId, browser.liveUrl);
      this.retained = { sessionId, browserId: browser.id, url: browser.liveUrl, taskId, expiresAt: Date.now() + 15 * 60000 };
    }
    return browser.id;
  }
  async recover(protectedIds: string[] = []) {
    for (const id of protectedIds) this.inherited.delete(id);
    if (!this.opts.key || !this.inherited.size) return;
    if (!this.recovery) this.recovery = (async () => { for (const id of [...this.inherited]) await this.stopOwned(id); })().finally(() => { this.recovery = null; });
    await this.recovery;
  }
  private async stopOwned(id: string) {
    if (!this.owned.has(id)) return;
    await this.api(`/browsers/${encodeURIComponent(id)}`, "PATCH", { action: "stop" }).catch((e) => { if (e.status !== 404) throw e; });
    this.owned.delete(id); this.inherited.delete(id); this.save();
    if (this.retained?.browserId === id) this.retained = undefined;
  }
  async closeBrowser() { for (const id of [...this.owned]) await this.stopOwned(id); this.candidate = undefined; }
  liveView(id: string): string | undefined { return this.views.get(id); }
  private async api<T>(route: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    if (!this.opts.key) throw new Error("Connect Browser Use Cloud in Settings before running cloud tasks.");
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseURL ?? "https://api.browser-use.com/api/v4"}${route}`, {
      method, headers: { "X-Browser-Use-API-Key": this.opts.key, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    if (!res.ok) throw Object.assign(new Error(`Browser Use returned HTTP ${res.status}; inspect the existing run before retrying.`), { status: res.status });
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
  async run(task: WorkTask, ctx: WorkContext): Promise<string> {
    if (!this.opts.key) throw new Error("Connect Browser Use Cloud in Settings before running cloud tasks.");
    await this.recover(task.providerBrowserId ? [task.providerBrowserId] : []);
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
        ...(this.opts.retainBrowser ? { keepAlive: 900 } : {}),
        ...(task.providerSessionId || (this.retained && this.retained.expiresAt > Date.now()) ? { sessionId: task.providerSessionId ?? this.retained!.sessionId } : { browserSettings: {
          ...(this.opts.profileId ? { profileId: this.opts.profileId } : {}), proxyCountryCode: this.opts.proxyCountryCode ?? "us", record: this.opts.record ?? false,
        } }),
      }, ctx.signal);
      if (!run.id || !run.sessionId) throw new Error("Browser Use did not acknowledge a valid run; do not retry blindly.");
      ctx.update({ providerRunId: run.id, providerSessionId: run.sessionId, providerCursor: 0, providerBrowserId: undefined, dispatching: false });
    }
    let cursor = task.providerRunId === run.id ? task.providerCursor ?? 0 : 0;
    if (this.opts.retainBrowser) this.candidate = { sessionId: run.sessionId, taskId: task.id, expiresAt: Date.now() + 15 * 60000 };
    let browserId = task.providerRunId === run.id ? task.providerBrowserId : undefined;
    if (!browserId && this.retained?.sessionId === run.sessionId && this.retained.expiresAt > Date.now()) { browserId = this.retained.browserId; this.retained.taskId = task.id; this.views.set(task.id, this.retained.url); }
    if (browserId && this.opts.retainBrowser && !this.retained) {
      const browser = await this.api<{ status: string; liveUrl?: string }>(`/browsers/${encodeURIComponent(browserId)}`, "GET", undefined, ctx.signal);
      if (browser.status === "active" && browser.liveUrl?.startsWith("https://")) { this.views.set(task.id, browser.liveUrl); this.retained = { sessionId: run.sessionId, browserId, url: browser.liveUrl, expiresAt: Date.now() + 15 * 60000, taskId: task.id }; }
    }
    const deadlineAt = task.providerRunId === run.id && task.providerDeadlineAt && !ended.has(run.status) ? task.providerDeadlineAt : Date.now() + Math.max(1, this.opts.timeoutMs ?? 15 * 60_000);
    ctx.update({ providerDeadlineAt: deadlineAt });
    const deadline = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
    const signal = AbortSignal.any([ctx.signal, deadline]);
    let terminal = ended.has(run.status);
    let succeeded = false;
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
            const liveUrl = event.data.live_view_url ?? event.data.liveUrl;
            const foundId = event.data.browser_session_id ?? event.data.browserId;
            if (typeof liveUrl === "string" && /^https:\/\//.test(liveUrl)) this.views.set(task.id, liveUrl);
            if (typeof foundId === "string") { browserId = foundId; this.owned.add(foundId); this.save(); }
            const view = this.views.get(task.id);
            if (browserId && view && this.opts.retainBrowser) this.retained = { sessionId: run.sessionId, browserId, url: view, expiresAt: Date.now() + 15 * 60000, taskId: task.id };
            ctx.update({ providerCursor: cursor, ...(browserId ? { providerBrowserId: browserId } : {}), progress: event.type.replace(/[._]/g, " ") });
          }
          more = !!page.hasMore;
          if (more && !page.events.length) throw new Error("Browser Use event cursor did not advance");
        }
        if (this.opts.retainBrowser && (!browserId || !this.views.get(task.id))) {
          const found = await this.lookupView(task.id, run.sessionId, signal).catch(() => undefined);
          if (found) { browserId = found; ctx.update({ providerBrowserId: found }); }
        }
        if (ended.has(status.status)) {
          const final = await this.api<Run>(`/runs/${run.id}`, "GET", undefined, signal);
          if (final.status !== "completed") throw new Error(final.error || `Cloud run ${final.status}`);
          if (!final.result?.trim()) throw new Error("The cloud run ended without a result. Review its evidence before considering this task complete.");
          if (this.retained && this.retained.browserId === browserId) this.retained.expiresAt = Date.now() + 15 * 60000;
          succeeded = true;
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
      const keep = this.opts.retainBrowser && succeeded && this.retained?.browserId === browserId && !signal.aborted;
      if (browserId && !keep) {
        this.owned.add(browserId); this.save();
        await this.stopOwned(browserId).catch(() => failures.push("browser shutdown"));
      }
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
