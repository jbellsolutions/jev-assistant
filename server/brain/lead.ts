/** The lead (v11.5): the model the user talks to. It takes the request, answers what it can itself,
 *  and for anything that needs his computer it plans, hands the worker one job at a time, checks
 *  each report, keeps what was learned on the task, and carries the task to its end.
 *
 *  Why: live 2026-09-28 "log into Salesforce, create an External Client App, get the keys" took
 *  seven runs and never finished. Each run was the worker alone, 20 steps, starting from scratch —
 *  so it guessed hostnames, filled a form with invented values and ended every run with "time
 *  ran out". the user: the reasoning model should be the intake and the orchestrator, and Jev the
 *  worker that gets deployed.
 *
 *  The lead has no hands of its own: `work` (a job for the worker), `note` (a fact for the task),
 *  `say` (a spoken progress line) and `finish` (close the task). The worker is the existing
 *  AgentBrain, unchanged at its core, run in job mode: its own brief and budget, no chat. */
import { generateText, isStepCount, type LanguageModel, type ModelMessage, tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ApprovalChoice, BrainEvent, BrainRun } from "../../core/brain.js";
import { isProviderFailure } from "../../core/brain.js";
import { type AgentBrain, FROM_COFOUNDER, type JobEnd } from "./agent.js";
import { type AttachmentRef, AttachmentStore, withAttachments } from "../attachments.js";
import { ChatStore } from "./chat-store.js";
import { hostOf, hostsIn } from "./hosts.js";
import type { BrainWithHealth } from "./index.js";
import { SPOKEN_REPLY_RULE } from "./instructions.js";
import type { RunLog } from "./runlog.js";
import type { JobStatus, TaskStore } from "./task-store.js";

export const DEFAULT_LEAD_MODEL = "openai/gpt-6-luna-pro";

export const LEAD_LIMITS = {
  /** Lead model calls per turn. Each job is one; planning, notes and says are the rest. */
  maxSteps: 40,
  /** Worker jobs per turn. */
  maxJobs: 12,
  /** One turn of the lead, jobs included, before it must report back. */
  maxWallMs: 30 * 60_000,
  /** One worker job. 25 steps: the Salesforce login-to-Setup path alone took 19. */
  job: { maxSteps: 25, maxWallMs: 5 * 60_000, wrapUpMs: 45_000 },
  /** Spoken progress lines are at least this far apart. */
  sayGapMs: 15_000,
  historyTurns: 12,
  historyChars: 24_000,
};

export const LEAD_INSTRUCTIONS = `You are Jev, the user's voice assistant on his Mac — the one he talks to. You think, plan and keep
track. Your worker (a fast computer-use model) does the hands-on work: his Chrome with all his
logins (in Jev's own background window, never on his screen), his Mac apps, the shell, Jev's own
browsers, the co-founder's computer, and connected apps (ClickUp, Slack, Gmail).

Answer directly — without the worker — anything you can answer from what you know or from the
conversation.

For anything that needs his computer or the web:
1. If the work needs details only the user can give (a name, an email, where something should end
   up), ask for all of them in ONE short question before starting. Never invent them, and never let
   the worker invent them.
2. Tell him the plan in one short sentence — put it in the first work call's say field (or use say)
   — what you're about to do and what you'll bring back. Text you write alongside a tool call is
   never heard.
3. Hand the worker one clear job at a time with work: one outcome per job ("log into Salesforce and
   open Setup → External Client App Manager"), a done_when that says how it knows it's finished,
   and every value it needs spelled out. The worker remembers nothing between jobs except what you
   put in the job and the task's facts — so include the URLs, hosts and names it needs.
4. After each job, record what later jobs need with note (the org's host, a working URL, an id,
   the name of what was created). Read its report critically: did it really do it? If it stopped
   at the step limit or was blocked, continue with a narrower job or another route — don't give up
   after one try, and don't repeat a job that already worked.
5. Use say at real milestones ("I'm in — creating the app now"), not for every job.
6. Carry the task to the end state the user wants. If keys or data were the means, put them where
   they belong. Writes (sending, saving, submitting, running a command) are put to the user
   automatically when the worker does them — don't ask him yourself first.
7. When the task is complete, call finish, then answer him. If he drops it, call finish with
   outcome dropped.

An open task (shown below when there is one) is continued by what the user says next unless he
clearly starts something new — then finish the old one as dropped first.
Files the user attaches (a charter, a project plan, a screenshot) come with his message. A long one
arrives as its outline and its start; read_doc reads further. Work from what the document actually
says, and quote it when it matters.
Secrets (API keys, client secrets, passwords) appear as {{secret:…}} handles. Pass the handle to the
worker to type or save; never ask for, repeat or speak the value.`;

/** What each worker job is told, on top of its standing instructions. */
export function jobBrief(job: { goal: string; doneWhen: string; tab?: string }, task: { goal: string; facts: Record<string, string>; hosts: string[] } | null): string {
  const lines = [
    "THIS RUN IS ONE JOB FOR JEV'S LEAD. You are the hands; the lead talks to the user and plans the rest.",
    `Job: ${job.goal}`,
    `Done when: ${job.doneWhen}`,
  ];
  if (task) {
    lines.push(`Part of the user's task: ${task.goal}`);
    const facts = Object.entries(task.facts);
    if (facts.length) lines.push("Known facts — trust these over any guess:", ...facts.map(([k, v]) => `- ${k}: ${v}`));
    if (task.hosts.length) lines.push(`Sites already visited in this task: ${task.hosts.join(", ")}`);
  }
  lines.push(
    job.tab === "his_tab"
      ? "Work in the tab the user is looking at (tab: his_tab) — he asked for that."
      : "Work in Jev's own background Chrome window (the default tab). Do not use his_tab.",
    "Rules for this job:",
    "- Never type a value you were not given in this job or did not read on the page. If a value you need is missing, stop and report needs_input, naming it.",
    "- Never make up a URL or hostname. Use the known facts, or get there through the site's own links and menus.",
    "- If a page is an error page, go back to the last page that worked; it is not a sign that he is logged out.",
    "- Keys, secrets and passwords show up as {{secret:…}} handles. Give each one you need later a name with the secret tool (e.g. sf_consumer_key) and report the names; type one by writing its handle.",
    "- Stop as soon as this job is done. Do not start the next part of the task.",
    "Start your final reply with one line exactly: STATUS: done, STATUS: blocked, STATUS: needs_input or STATUS: failed. Then say what you did and what you found: the exact URLs of the pages that mattered, names, ids.",
  );
  return lines.join("\n");
}

/** The worker's own STATUS line, or what the way it ended says. */
export function jobStatus(end: JobEnd): JobStatus {
  if (end.reason === "interrupted") return "interrupted";
  if (end.reason === "aborted") return "interrupted";
  if (end.reason === "failed") return "failed";
  const said = /STATUS:\s*(done|blocked|needs_input|failed)/i.exec(end.output)?.[1]?.toLowerCase() as JobStatus | undefined;
  if (end.reason === "cap" || end.reason === "wrapped_up" || end.reason === "wall_clock") return said === "done" ? "done" : "step_limit";
  return said ?? "done";
}

/** A buffered async queue (same shape as agent.ts's): events pushed before anyone reads are kept. */
class Channel<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: Array<(r: IteratorResult<T>) => void> = [];
  private done = false;
  push(item: T): void {
    if (this.done) return;
    const w = this.waiting.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  end(): void {
    this.done = true;
    for (const w of this.waiting.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiting.push(r));
      },
    };
  }
}

interface LeadRun {
  id: string;
  ctrl: AbortController;
  events: Channel<BrainEvent>;
  steers: string[];
  /** The worker job in progress, if any: approvals and nudges go to it. */
  jobId: string | null;
  jobs: number;
  lastSayAt: number;
  said: Set<string>;
  chat: ChatStore;
  chatGen: number;
  from?: "cofounder";
  noHistory: boolean;
  /** Files the user attached to this message. */
  attachments: AttachmentRef[];
}

export interface LeadOptions {
  model: LanguageModel;
  modelId: string;
  worker: AgentBrain;
  tasks: TaskStore;
  chat?: ChatStore;
  cofounderChat?: ChatStore;
  spoken?: boolean;
  instructions?: () => string;
  limits?: Partial<typeof LEAD_LIMITS>;
  log?: RunLog;
  generate?: typeof generateText;
  now?: () => number;
  /** Files the user attaches in the panel; ~/.jev/attachments when not given. */
  attachments?: AttachmentStore;
}

export class LeadBrain implements BrainWithHealth {
  readonly name = "Jev";
  readonly modelId: string;
  private readonly limits: typeof LEAD_LIMITS;
  private readonly chat: ChatStore;
  private readonly cofounderChat: ChatStore;
  private readonly runs = new Map<string, LeadRun>();
  private seq = 0;

  constructor(private readonly opts: LeadOptions) {
    this.modelId = opts.modelId;
    this.limits = { ...LEAD_LIMITS, ...opts.limits, job: { ...LEAD_LIMITS.job, ...opts.limits?.job } };
    this.chat = opts.chat ?? new ChatStore(null);
    this.cofounderChat = opts.cofounderChat ?? new ChatStore(null);
    this.store = opts.attachments ?? new AttachmentStore();
  }

  private readonly store: AttachmentStore;

  /** The message's files join the open task, so a charter stays in view for the whole project. */
  private attachToTask(run: LeadRun): void {
    if (!this.opts.tasks.current) return;
    for (const a of run.attachments) this.opts.tasks.attach(a);
  }

  /** A task this turn opened and fully did — every job done, and the answer isn't a question back
   *  to the user — is closed here, whether or not the lead called finish. Live 2026-09-29 a one-line
   *  question left its task open, and the next message (a charter) was filed under it. */
  private closeIfDone(openBefore: string | null, output: string): void {
    const t = this.opts.tasks.current;
    if (!t || t.id === openBefore || !t.jobs.length) return;
    if (!t.jobs.every((j) => j.status === "done") || /\?\s*$/.test(output.trim())) return;
    this.opts.tasks.close("done");
    this.opts.worker.secrets.clear();
  }

  get tasks(): TaskStore {
    return this.opts.tasks;
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    const worker = await this.opts.worker.health();
    return { ok: worker.ok, detail: `lead ${this.modelId} → worker ${worker.detail}` };
  }

  remember(user: string, outcome: string): void {
    this.chat.append(user, outcome, "action");
  }

  /** "New chat": the conversation ends, and so does any open task. */
  async reset(): Promise<void> {
    this.chat.reset();
    this.opts.tasks.close("dropped");
    this.opts.worker.secrets.clear();
  }

  async send(text: string, opts: { signal?: AbortSignal; fresh?: boolean; from?: "cofounder"; attachments?: AttachmentRef[] } = {}): Promise<BrainRun> {
    const chat = opts.from === "cofounder" ? this.cofounderChat : this.chat;
    const run: LeadRun = { id: `lead_${Date.now().toString(36)}_${++this.seq}`, ctrl: new AbortController(), events: new Channel(), steers: [], jobId: null, jobs: 0, lastSayAt: 0, said: new Set(), chat, chatGen: chat.generation, noHistory: !!opts.fresh, attachments: opts.attachments ?? [], ...(opts.from ? { from: opts.from } : {}) };
    opts.signal?.addEventListener("abort", () => run.ctrl.abort(), { once: true });
    this.runs.set(run.id, run);
    void this.execute(run, text);
    return { id: run.id, events: run.events };
  }

  /** Approvals are asked by the worker; the answer goes back to the job that asked. */
  async approve(runId: string, choice: ApprovalChoice, requestId?: string | null): Promise<void> {
    const run = this.runs.get(runId);
    if (run?.jobId) await this.opts.worker.approve(run.jobId, choice, requestId);
  }

  /** the user, mid-run ("you're on the right page — make a new one"): the job in progress finishes at
   *  its next step and reports, and the lead reads what he said before deciding what comes next. */
  async steer(runId: string, text: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.steers.push(text);
    this.opts.log?.write(run.id, { type: "steer", text });
    run.events.push({ kind: "steered" });
    if (run.jobId) this.opts.worker.interrupt(run.jobId);
  }

  async stop(runId: string): Promise<void> {
    this.runs.get(runId)?.ctrl.abort();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private tools(run: LeadRun, request: string, signal: AbortSignal): ToolSet {
    const tasks = this.opts.tasks;
    const limits = this.limits;
    /** One line out loud: never a repeat, never two within sayGapMs. */
    const speak = (text: string): string => {
      const line = text.trim().replace(/\s+/g, " ").slice(0, 240);
      if (!line) return "Nothing to say.";
      if (run.said.has(line.toLowerCase())) return "Already said that — don't repeat it.";
      const now = this.now();
      if (run.lastSayAt && now - run.lastSayAt < limits.sayGapMs) return "You spoke a moment ago; save this for the next milestone.";
      run.said.add(line.toLowerCase());
      run.lastSayAt = now;
      run.events.push({ kind: "say", text: line });
      this.opts.log?.write(run.id, { type: "say", text: line });
      return "Said.";
    };
    return {
      work: tool({
        description: "Hand the worker ONE job on the user's computer or the web, and wait for its report. One outcome per job; spell out every value it needs.",
        inputSchema: z.object({
          goal: z.string().describe("The one outcome, with every value the worker needs spelled out"),
          done_when: z.string().describe("How the worker knows it is finished"),
          tab: z.enum(["background", "his_tab"]).optional().describe("background (default): Jev's own Chrome window. his_tab only when the user asked about the page he's looking at."),
          say: z.string().optional().describe("One short sentence said aloud to the user as this job starts: the plan the first time, a real milestone after. Omit when there's nothing new to say."),
        }),
        execute: async (input) => {
          if (signal.aborted) return "Stopped.";
          if (run.jobs >= limits.maxJobs) return `That's ${limits.maxJobs} jobs this turn — report back to the user with where things stand.`;
          run.jobs++;
          // spoken the moment the job starts, not after it — Luna's plan line, on time
          if (input.say) speak(input.say);
          const task = tasks.current ?? tasks.open(request);
          this.attachToTask(run);
          const brief = jobBrief({ goal: input.goal, doneWhen: input.done_when, ...(input.tab ? { tab: input.tab } : {}) }, task);
          let ended: JobEnd = { reason: "failed", output: "The job ended without a report.", steps: 0 };
          const job = await this.opts.worker.send(input.goal, {
            signal,
            ...(run.from ? { from: run.from } : {}),
            job: {
              brief,
              limits: limits.job,
              onEnd: (e) => (ended = e),
              onPage: (url) => {
                const host = hostOf(url);
                if (host) tasks.sawHost(host);
              },
              // real hosts: where pages landed, and any the user or the facts wrote down
              hosts: () => {
                const t = tasks.current;
                return t ? [...t.hosts, ...hostsIn(`${t.goal}\n${Object.values(t.facts).join("\n")}\n${request}`)] : hostsIn(request);
              },
              tab: input.tab ?? "background",
            },
          });
          run.jobId = job.id;
          try {
            for await (const ev of job.events) {
              // the panel and the session see the worker's hands at work, and its questions
              if (ev.kind === "tool_start" || ev.kind === "tool_end" || ev.kind === "approval" || ev.kind === "approved") run.events.push(ev);
            }
          } finally {
            run.jobId = null;
          }
          const status = jobStatus(ended);
          const report = ended.output || "(no report)";
          tasks.addJob(input.goal, status, report);
          const nudges = run.steers.length ? `\n\nthe user said while it worked:\n${run.steers.map((s) => `- ${s}`).join("\n")}` : "";
          return `Job ${status} after ${ended.steps} steps.\nWorker's report:\n${report}${nudges}`;
        },
      }),
      note: tool({
        description: "Record a fact the rest of the task needs (the org's host, a working URL, an id, the name of what was created).",
        inputSchema: z.object({ key: z.string(), value: z.string() }),
        execute: async ({ key, value }) => {
          (tasks.current ?? tasks.open(request)) && tasks.note(key, value);
          this.attachToTask(run);
          return "Noted.";
        },
      }),
      say: tool({
        description: "Say one short sentence to the user now, out loud, while the work carries on: the plan at the start, then real milestones.",
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => speak(text),
      }),
      read_doc: tool({
        description: "Read more of a document the user attached (a charter, a plan): the text from a character offset. Its id is in the message or the task.",
        inputSchema: z.object({
          id: z.string().describe("The attachment id, e.g. att_…"),
          from: z.number().int().min(0).optional().describe("Character offset to start at (default 0)"),
          chars: z.number().int().min(500).max(40_000).optional().describe("How much to read (default 20000)"),
        }),
        execute: async ({ id, from = 0, chars = 20_000 }) => {
          const meta = this.store.get(id);
          if (!meta) return `No attached document ${id}.`;
          try {
            const c = await this.store.content(id);
            if (c.kind === "image") return `${meta.name} is an image; it was shown with the message it came with.`;
            const part = c.text.slice(from, from + chars);
            const end = from + part.length;
            return `${meta.name}, characters ${from}–${end} of ${c.text.length}:\n${part}${end < c.text.length ? `\n… (more: read_doc from ${end})` : "\n(end of document)"}`;
          } catch (err) {
            return `Couldn't read ${meta.name}: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      }),
      finish: tool({
        description: "Close the open task: done when the user's end state is reached, dropped when he abandons it.",
        inputSchema: z.object({ outcome: z.enum(["done", "dropped"]), summary: z.string().optional() }),
        execute: async ({ outcome }) => {
          const t = tasks.close(outcome);
          this.opts.worker.secrets.clear();
          return t ? `Task ${outcome}.` : "No task was open.";
        },
      }),
    };
  }

  private historyMessages(run: LeadRun): ModelMessage[] {
    return run.chat.recent(this.limits.historyTurns, this.limits.historyChars).flatMap((t): ModelMessage[] => [
      { role: "user", content: t.user },
      { role: "assistant", content: t.kind === "action" ? `(done straight away) ${t.assistant}` : t.assistant },
    ]);
  }

  private instructions(run: LeadRun): string {
    const parts = [this.opts.instructions?.() ?? LEAD_INSTRUCTIONS];
    if (this.opts.spoken) parts.push(SPOKEN_REPLY_RULE);
    if (run.from === "cofounder") parts.push(FROM_COFOUNDER);
    const brief = this.opts.tasks.brief();
    if (brief) parts.push(brief);
    return parts.join("\n\n");
  }

  private async execute(run: LeadRun, text: string): Promise<void> {
    const started = this.now();
    const wall = new AbortController();
    const timer = setTimeout(() => wall.abort(), this.limits.maxWallMs);
    const signal = AbortSignal.any([run.ctrl.signal, wall.signal]);
    const log = this.opts.log;
    const instructions = this.instructions(run);
    log?.write(run.id, { type: "start", text, model: this.modelId, tools: ["work", "note", "say", "finish", "read_doc"], ...(run.attachments.length ? { attachments: run.attachments.map((a) => a.name) } : {}) });
    // a charter dropped into an open task stays with the task
    this.attachToTask(run);
    const openBefore = this.opts.tasks.current?.id ?? null;
    const content = await withAttachments(this.store, text, run.attachments);
    // the chat keeps that files came, not their contents: a follow-up reads them with read_doc
    const heard = run.attachments.length ? `${text}\n[attached: ${run.attachments.map((a) => `${a.name} (${a.id})`).join(", ")}]` : text;
    let steps = 0;
    const end = (reason: JobEnd["reason"], output: string) => log?.write(run.id, { type: "end", reason, output, ms: this.now() - started, steps });
    try {
      const result = await (this.opts.generate ?? generateText)({
        model: this.opts.model,
        instructions,
        messages: [...(run.noHistory ? [] : this.historyMessages(run)), { role: "user", content } as ModelMessage],
        tools: this.tools(run, text, signal),
        stopWhen: [isStepCount(this.limits.maxSteps)],
        abortSignal: signal,
        maxRetries: 1,
        // the user's nudges ride on the instructions for every step after them
        prepareStep: () => (run.steers.length ? { instructions: `${this.instructions(run)}\n\nWhile you were working, the user said:\n${run.steers.map((s) => `- ${s}`).join("\n")}` } : undefined),
        onStepFinish: (step) => {
          steps++;
          log?.write(run.id, { type: "step", n: steps, text: step.text, finishReason: String(step.finishReason), inputTokens: step.usage?.inputTokens, outputTokens: step.usage?.outputTokens });
        },
      } as Parameters<typeof generateText>[0]);
      const said = result.text.trim();
      const output = said || (result.finishReason === "tool-calls" ? "I've used all the steps I had for this turn — tell me to carry on and I'll continue from where the task stands." : "Done.");
      run.chat.append(heard, output, "brain", run.chatGen);
      this.closeIfDone(openBefore, output);
      run.events.push({ kind: "delta", text: output });
      run.events.push({ kind: "completed", output });
      end(said ? "answered" : "cap", output);
    } catch (err) {
      if (run.ctrl.signal.aborted) {
        run.chat.append(heard, "(stopped before answering)", "brain", run.chatGen);
        run.events.push({ kind: "cancelled" });
        end("aborted", "");
      } else if (wall.signal.aborted) {
        const output = "That's taken half an hour, so I've paused here — the task is still open. Tell me to carry on and I'll pick it up where it stands.";
        run.chat.append(heard, output, "brain", run.chatGen);
        run.events.push({ kind: "delta", text: output });
        run.events.push({ kind: "completed", output });
        end("wall_clock", output);
      } else {
        const error = err instanceof Error ? err.message : String(err);
        const providerFailure = isProviderFailure(error);
        if (!providerFailure) run.chat.append(heard, `(couldn't finish: ${error.slice(0, 300)})`, "brain", run.chatGen);
        run.events.push({ kind: "failed", error, providerFailure });
        end("failed", error);
      }
    } finally {
      clearTimeout(timer);
      this.runs.delete(run.id);
      run.events.end();
    }
  }
}

export { hostOf } from "./hosts.js";
