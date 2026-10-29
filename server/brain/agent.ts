/** Jev's brain: the Vercel AI SDK's tool loop, inside the app, behind the same `Brain` seam the
 *  session, the panel's brain card and its approval card already speak.
 *
 *  Every control that failed with Hermes is a line of code here, not a sentence in a prompt:
 *  - the tool list is short and named (`tools.ts`), never a toolkit or a search;
 *  - a run is bounded by a step cap AND a wall clock, then it stops and says so — nothing detaches
 *    and keeps running in the background;
 *  - Stop aborts the run's signal, which every tool checks;
 *  - a write waits for the user inside the tool (`ask`), so the run's bounds still apply while it waits;
 *  - earlier turns are carried as plain text, capped by count and size — nothing grows to 87k;
 *  - the model is always an explicit OpenRouter instance. A bare model-id string would route through
 *    Vercel's paid AI Gateway by default, and a test pins that it never does. */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, isStepCount, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { type ApprovalChoice, type BrainEvent, type BrainRun, isProviderFailure } from "../../core/brain.js";
import { type AppsLoad, type AppsLoader, createComposioApps, gateApps } from "./apps.js";
import { loadBrainInstructions } from "./instructions.js";
import { fileRunLog, type RunLog } from "./runlog.js";
import { compactImages, compactScreens } from "./compact.js";
import { type Chat, ChatStore } from "./chat-store.js";
import { type AttachmentRef, AttachmentStore, withAttachments } from "../attachments.js";
import { hostsIn } from "./hosts.js";
import { SecretVault } from "./secrets.js";
import { buildTools, type Hands, isSeen, TOOL_NAMES, type ToolContext } from "./tools.js";
import type { BrainWithHealth } from "./index.js";

export const DEFAULT_MODEL = "z-ai/glm-5.3-flash";

export const LIMITS = {
  /** Model calls per run. A job that needs more is a job to break up, not to let wander. 20, not 12:
   *  a Mac action now returns the window it left behind, so steps buy actions rather than re-reads. */
  maxSteps: 20,
  /** Wall clock per run, including time spent waiting for the user's yes/no. */
  maxWallMs: 4 * 60_000,
  /** Time kept back at the end for one last model call that answers from what was found. Live
   *  2026-09-25: "check Slack" had the answer by step 9, kept exploring, and at 4:00 said only "I
   *  stopped". A model step here takes up to ~17s; this leaves room for two. */
  wrapUpMs: 45_000,
  /** Earlier turns of the chat carried into a new run, as plain text. The whole chat is kept on
   *  disk (ChatStore); this is how much of it the model sees. */
  historyTurns: 12,
  historyChars: 24_000,
};

export const CAP_LINE = "I stopped — that was taking too many steps. Tell me what to focus on and I'll pick it up from there.";
export const WALL_LINE = "I stopped — that was taking too long.";
/** The wrap-up's brief: answer from what was found. */
export const WRAP_UP = "You've reached the step limit for this request (it is a step limit, not a time limit — never say time ran out unless it did). Answer now from what was already found below — say plainly what you did, what you found and what is left to do. Do not ask to look further.";
/** Per tool result, and in total, what the wrap-up is shown. The latest results matter most. */
const FOUND_CHARS_EACH = 2_500;
const FOUND_CHARS = 14_000;
/** The wrap-up is one short model call with its own clock, so a run that hit the wall still answers. */
const WRAP_UP_TIMEOUT_MS = 40_000;
/** A reply that is really a tool call written out as text (GLM does this when it has no tools). */
const TOOL_MARKUP = /<\/?tool_call>|<arg_key>|<arg_value>/;

/** A buffered async queue: events pushed before anyone iterates are kept, and iteration ends at `end()`. */
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

interface Run {
  id: string;
  ctrl: AbortController;
  events: Channel<BrainEvent>;
  approvals: Map<string, (ok: boolean) => void>;
  steers: string[];
  /** What each tool handed back, as plain text — what the wrap-up answers from. */
  found: string[];
  /** Send this run without the chat (a retry after repeated model errors). */
  noHistory?: boolean;
  /** The chat this run belongs to (ChatStore.generation when it started). */
  chatGen?: number;
  /** the user's chat, or the co-founder's own for a request that came from it. */
  chat: ChatStore;
  from?: "cofounder";
  /** A job for the lead (v11.5): its own brief and budget, no chat, reported back when it ends. */
  job?: JobSpec;
  /** Stop at the next step boundary and report what was done (a nudge from the user mid-job). */
  interrupted?: boolean;
  /** Files the user attached to this message (when there is no lead to read them). */
  attachments?: AttachmentRef[];
}

/** How a worker job ended, for the lead. */
export interface JobEnd {
  reason: "answered" | "wrapped_up" | "cap" | "wall_clock" | "aborted" | "failed" | "interrupted";
  output: string;
  steps: number;
}

/** One job the lead hands the worker: the goal and what is known, written as instructions. */
export interface JobSpec {
  brief: string;
  limits?: Partial<Pick<typeof LIMITS, "maxSteps" | "maxWallMs" | "wrapUpMs">>;
  onEnd?: (end: JobEnd) => void;
  /** Every page a chrome call landed on (the task's host memory). */
  onPage?: (url: string) => void;
  /** Hosts already seen in this task (the host guard's starting knowledge). */
  hosts?: () => string[];
  /** The Chrome window this job works in. A background job may not move into the user's tab. */
  tab?: "background" | "his_tab";
}

/** Added to the instructions for a request that came from the co-founder over the tailnet. */
export const FROM_COFOUNDER = `This request comes from the user's co-founder agent (Hermes on its Orgo computer), not from the user himself. Do what it asks on the user's Mac with the same rules as always — anything that sends, posts, deletes or runs an unlisted command is asked of the user, who decides. Answer the co-founder plainly and briefly; your answer goes back to it, not to the user.`;

export interface AgentBrainOptions {
  model: LanguageModel;
  modelId: string;
  hands: Hands;
  /** Read per run, so an edited ~/.jev/brain-instructions.md applies without a restart. */
  instructions: () => string;
  limits?: Partial<typeof LIMITS>;
  log?: RunLog;
  /** The SDK call itself; tests swap in a scripted model rather than this. */
  generate?: typeof generateText;
  /** Connectors (Composio): a named list of app actions, loaded once, on first use. */
  apps?: AppsLoader | null;
  appWriteAllowed?: (slug: string, account: string) => boolean;
  /** Owner setting for requested work; never inherited by co-founder-originated runs. */
  permissionsEnabled?: () => boolean;
  /** Enforce the selected execution environment before exposing tools to the model. */
  ownTools?: readonly string[];
  /** The ongoing chat; in memory only when not given. */
  chat?: ChatStore;
  /** The co-founder's requests keep their own chat, never the user's. In memory when not given. */
  cofounderChat?: ChatStore;
  /** Where secrets seen by tools are held (masked from the model). One per brain when not given. */
  secrets?: SecretVault;
  /** Files attached in the panel; ~/.jev/attachments when not given. */
  attachments?: AttachmentStore;
  provider?: "OpenAI" | "OpenRouter";
}

export class AgentBrain implements BrainWithHealth {
  readonly name = "Jev";
  readonly modelId: string;
  private readonly limits: typeof LIMITS;
  private readonly chat: ChatStore;
  private readonly cofounderChat: ChatStore;
  private readonly runs = new Map<string, Run>();
  private seq = 0;
  private askSeq = 0;
  private appsLoad: Promise<AppsLoad> | null = null;
  /** Keys and passwords the tools came across, as handles only the executors can open. */
  readonly secrets: SecretVault;

  constructor(private readonly opts: AgentBrainOptions) {
    this.secrets = opts.secrets ?? new SecretVault();
    this.limits = { ...LIMITS, ...opts.limits };
    this.modelId = opts.modelId;
    this.chat = opts.chat ?? new ChatStore(null);
    this.cofounderChat = opts.cofounderChat ?? new ChatStore(null);
  }

  /** The chat as it stands: for the panel's "Chat · N turns" line. */
  chatInfo(): Pick<Chat, "id" | "startedAt"> & { turns: number } {
    const c = this.chat.chat;
    return { id: c.id, startedAt: c.startedAt, turns: c.turns.length };
  }

  /** Something Jev did straight away (no brain run) — kept so a follow-up has it in view. */
  remember(user: string, outcome: string): void {
    this.chat.append(user, outcome, "action");
  }

  get model(): LanguageModel {
    return this.opts.model;
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    const apps = this.opts.apps ? ` · connectors: ${(await this.apps()).note}` : " · connectors: off (no COMPOSIO_API_KEY)";
    return { ok: true, detail: `${this.modelId} via ${this.opts.provider ?? "OpenRouter"} · ${TOOL_NAMES.length} tools: ${TOOL_NAMES.join(", ")}${apps}` };
  }

  /** The connector actions, loaded once. A failure is remembered as a note, never thrown into a run. */
  apps(): Promise<AppsLoad> {
    if (!this.opts.apps) return Promise.resolve({ tools: {}, note: "off" });
    this.appsLoad ??= this.opts.apps.load().catch((err) => {
      this.appsLoad = null; // try again on the next run: a transient outage should not stick
      return { tools: {}, note: `unavailable (${err instanceof Error ? err.message : String(err)})` };
    });
    return this.appsLoad;
  }

  /** `fresh` sends this one request without the chat in view — the retry after repeated model
   *  errors, in case the chat itself is what the model is choking on. It never erases the chat:
   *  only the user does that ("new chat"). */
  async send(text: string, opts: { signal?: AbortSignal; fresh?: boolean; from?: "cofounder"; job?: JobSpec; attachments?: AttachmentRef[] } = {}): Promise<BrainRun> {
    // a job keeps no chat: the lead holds the conversation, and the task holds what was learned
    const chat = opts.job ? new ChatStore(null) : opts.from === "cofounder" ? this.cofounderChat : this.chat;
    const run: Run = { id: `${opts.job ? "job" : "run"}_${Date.now().toString(36)}_${++this.seq}`, ctrl: new AbortController(), events: new Channel(), approvals: new Map(), steers: [], found: [], noHistory: !!opts.fresh || !!opts.job, chatGen: chat.generation, chat, ...(opts.from ? { from: opts.from } : {}), ...(opts.job ? { job: opts.job } : {}), ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) };
    opts.signal?.addEventListener("abort", () => run.ctrl.abort(), { once: true });
    this.runs.set(run.id, run);
    void this.execute(run, text);
    return { id: run.id, events: run.events };
  }

  async reset(): Promise<void> {
    this.chat.reset();
  }

  async approve(runId: string, choice: ApprovalChoice, requestId?: string | null): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    const key = requestId && run.approvals.has(requestId) ? requestId : run.approvals.keys().next().value;
    if (!key) return;
    const resolve = run.approvals.get(key)!;
    run.approvals.delete(key);
    const ok = choice !== "deny";
    this.opts.log?.write(run.id, { type: "answer", ok });
    run.events.push({ kind: "approved", choice });
    resolve(ok);
  }

  async steer(runId: string, text: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.steers.push(text);
    this.opts.log?.write(run.id, { type: "steer", text });
    run.events.push({ kind: "steered" });
  }

  async stop(runId: string): Promise<void> {
    this.runs.get(runId)?.ctrl.abort();
  }

  /** Finish at the next step boundary and report what was done — unlike stop(), nothing is cut off
   *  mid-action, and the run still answers (the wrap-up) with what it found. */
  interrupt(runId: string): void {
    const run = this.runs.get(runId);
    if (run) run.interrupted = true;
  }

  /** Ask the user before a write. False on "no", on Stop, and on the wall clock. */
  private ask(run: Run, signal: AbortSignal, summary: string): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (run.from !== "cofounder" && this.opts.permissionsEnabled?.()) return Promise.resolve(true);
    const requestId = `ask_${run.id}_${++this.askSeq}`;
    this.opts.log?.write(run.id, { type: "ask", summary });
    return new Promise<boolean>((resolve) => {
      const settle = (ok: boolean) => {
        run.approvals.delete(requestId);
        resolve(ok);
      };
      run.approvals.set(requestId, settle);
      signal.addEventListener("abort", () => settle(false), { once: true });
      run.events.push({ kind: "approval", requestId, summary, choices: ["once", "deny"] });
    });
  }

  /** Every tool call is announced to the panel and written to the run log by OUR wrapper. */
  private wrap(run: Run, tools: ToolSet): ToolSet {
    const out: ToolSet = {};
    for (const [name, t] of Object.entries(tools)) {
      const execute = t.execute!;
      out[name] = {
        ...t,
        execute: (async (input: unknown, options: unknown) => {
          const mask = (t: string) => this.secrets.mask(t);
          const preview = mask(JSON.stringify(input ?? {})).slice(0, 160);
          // Work moved off the Mac app she last read: "Your screen" goes back to the user's own window.
          if (!name.startsWith("mac_")) (this.opts.hands.mac as { release?: () => void } | null)?.release?.();
          run.events.push({ kind: "tool_start", tool: name, preview });
          this.opts.log?.write(run.id, { type: "tool_start", tool: name, input: JSON.parse(mask(JSON.stringify(input ?? {}))) });
          const t0 = Date.now();
          try {
            const raw = await (execute as (i: unknown, o: unknown) => Promise<unknown>)(input, options);
            // a screenshot result keeps its image for the model; the log and the wrap-up get the text
            // secrets are masked before anything sees the result: the model, the log, the panel
            const output = mask(isSeen(raw) ? raw.text : String(raw));
            run.events.push({ kind: "tool_end", tool: name, durationMs: Date.now() - t0, error: false });
            this.opts.log?.write(run.id, { type: "tool_end", tool: name, ms: Date.now() - t0, output, error: false });
            run.found.push(`${name} ${preview}\n${output.slice(0, FOUND_CHARS_EACH)}`);
            return isSeen(raw) ? { ...raw, text: output } : output;
          } catch (err) {
            const message = mask(err instanceof Error ? err.message : String(err));
            run.events.push({ kind: "tool_end", tool: name, durationMs: Date.now() - t0, error: true });
            this.opts.log?.write(run.id, { type: "tool_end", tool: name, ms: Date.now() - t0, output: message, error: true });
            // handed back to the model as the result, so it can say what went wrong instead of guessing
            return `Error: ${message}`;
          }
        }) as typeof t.execute,
      } as ToolSet[string];
    }
    return out;
  }

  private historyMessages(run: Run): ModelMessage[] {
    return run.chat.recent(this.limits.historyTurns, this.limits.historyChars).flatMap((t): ModelMessage[] => [
      { role: "user", content: t.user },
      { role: "assistant", content: t.kind === "action" ? `(done straight away) ${t.assistant}` : t.assistant },
    ]);
  }

  private async execute(run: Run, text: string): Promise<void> {
    const started = Date.now();
    const limits = { ...this.limits, ...run.job?.limits };
    const wall = new AbortController();
    const timer = setTimeout(() => wall.abort(), limits.maxWallMs);
    const signal = AbortSignal.any([run.ctrl.signal, wall.signal]);
    const recordDir = this.opts.log?.dirFor?.(run.id);
    const ctx: ToolContext = {
      signal,
      ask: (summary: string) => this.ask(run, signal, summary),
      ...(recordDir ? { recording: { dir: recordDir, started: false, count: 0 } } : {}),
      ...(run.job?.onPage ? { onPage: run.job.onPage } : {}),
      // the host guard trusts what the user wrote and what the task has been on — never a guess
      knownHosts: () => [...(run.job?.hosts?.() ?? []), ...hostsIn(text), ...(run.noHistory ? [] : hostsIn(run.chat.recent(this.limits.historyTurns, this.limits.historyChars).map((t) => `${t.user}\n${t.assistant}`).join("\n")))],
      secrets: this.secrets,
      ...(run.from === "cofounder" ? { secretsLocked: true } : {}),
      ...(run.job ? { tab: run.job.tab ?? "background" } : {}),
    };
    const apps = await this.apps();
    if (run.from !== "cofounder" && this.opts.appWriteAllowed) ctx.appWriteAllowed = (slug) => {
      const account = apps.accounts?.[slug.split("_")[0]!.toLowerCase()];
      return !!account && this.opts.appWriteAllowed!(slug, account);
    };
    const own = buildTools(this.opts.hands, ctx);
    if (this.opts.ownTools) for (const name of Object.keys(own)) if (!this.opts.ownTools.includes(name)) delete own[name];
    // The co-founder can't hand work back to itself through Jev: no loops.
    if (run.from === "cofounder") delete own.cofounder;
    const tools = this.wrap(run, { ...own, ...gateApps(apps.tools, ctx) });
    const log = this.opts.log;
    log?.write(run.id, { type: "start", text: this.secrets.mask(text), model: this.modelId, tools: Object.keys(tools) });
    const base = run.from === "cofounder" ? `${this.opts.instructions()}\n\n${FROM_COFOUNDER}` : this.opts.instructions();
    const instructions = run.job ? `${base}\n\n${run.job.brief}` : base;
    const end = (reason: JobEnd["reason"], output: string, steps: number) => {
      log?.write(run.id, { type: "end", reason, output, ms: Date.now() - started, steps, ...(ctx.recording?.started ? { recording: ctx.recording.dir } : {}) });
      run.job?.onEnd?.({ reason, output, steps });
    };
    let steps = 0;
    try {
      const result = await (this.opts.generate ?? generateText)({
        model: this.opts.model,
        instructions,
        messages: [...(run.noHistory ? [] : this.historyMessages(run)), { role: "user", content: run.attachments ? await withAttachments(this.opts.attachments ?? new AttachmentStore(), text, run.attachments) : text } as ModelMessage],
        tools,
        // The step cap, or the clock nearly out: stop exploring and leave time to answer (below).
        stopWhen: [isStepCount(limits.maxSteps), () => Date.now() - started >= limits.maxWallMs - limits.wrapUpMs, () => !!run.interrupted],
        abortSignal: signal,
        maxRetries: 1,
        // A steer ("and also check X") joins the instructions for every remaining step.
        // Steers ride on the instructions; older screens are shortened so each step resends less.
        prepareStep: ({ messages }: { messages: ModelMessage[] }) => {
          const compacted = compactImages(compactScreens(messages));
          const steer = run.steers.length ? `${instructions}\n\nWhile you were working, the user added:\n${run.steers.map((s) => `- ${s}`).join("\n")}` : null;
          if (compacted === messages && !steer) return undefined;
          return { ...(compacted !== messages ? { messages: compacted } : {}), ...(steer ? { instructions: steer } : {}) };
        },
        onStepFinish: (step) => {
          steps++;
          log?.write(run.id, { type: "step", n: steps, text: step.text, finishReason: String(step.finishReason), inputTokens: step.usage?.inputTokens, outputTokens: step.usage?.outputTokens });
        },
      } as Parameters<typeof generateText>[0]);
      steps = result.steps.length;
      const said = result.text.trim();
      const unfinished = result.finishReason === "tool-calls" || TOOL_MARKUP.test(said);
      if (!unfinished) {
        const output = this.secrets.mask(said) || "Done.";
        this.rememberRun(run, text, output);
        run.events.push({ kind: "delta", text: output });
        run.events.push({ kind: "completed", output });
        end("answered", output, steps);
      } else {
        // Out of steps or time with the answer still unwritten: say what was found instead of
        // "I stopped". Live 2026-09-25: "check Slack" had it by step 9 and ended with nothing.
        const summary = await this.wrapUp(run, text, instructions);
        const output = summary ? this.secrets.mask(summary) : CAP_LINE;
        this.rememberRun(run, text, output);
        run.events.push({ kind: "delta", text: output });
        run.events.push({ kind: "completed", output });
        end(run.interrupted ? "interrupted" : summary ? "wrapped_up" : "cap", output, steps);
      }
    } catch (err) {
      if (run.ctrl.signal.aborted) {
        // kept, so "why did you stop?" or "carry on" still makes sense
        this.rememberRun(run, text, "(stopped before answering)");
        run.events.push({ kind: "cancelled" });
        end("aborted", "", steps);
      } else if (wall.signal.aborted) {
        const summary = await this.wrapUp(run, text, instructions);
        const output = summary ? this.secrets.mask(summary) : WALL_LINE;
        this.rememberRun(run, text, output);
        run.events.push({ kind: "delta", text: output });
        run.events.push({ kind: "completed", output });
        end(summary ? "wrapped_up" : "wall_clock", output, steps);
      } else {
        const error = err instanceof Error ? err.message : String(err);
        const providerFailure = isProviderFailure(error);
        // a model error is retried with the same words, so only a task that failed is kept
        if (!providerFailure) this.rememberRun(run, text, `(couldn't finish: ${error.slice(0, 300)})`);
        run.events.push({ kind: "failed", error, providerFailure });
        end("failed", error, steps);
      }
    } finally {
      clearTimeout(timer);
      for (const settle of [...run.approvals.values()]) settle(false);
      this.runs.delete(run.id);
      // the work is over: "Your screen" goes back to whatever the user has in front. Live 2026-09-29
      // it kept picturing Finder for the rest of the follow window after a run that ended on mac_read.
      if (![...this.runs.values()].length) (this.opts.hands.mac as { release?: () => void } | null)?.release?.();
      run.events.end();
    }
  }

  /** One tool-free call that answers the request from what the tools found, handed over as plain
   *  text rather than as tool messages — with tool messages in view, GLM writes a tool call out as
   *  text instead of answering. Null when there is nothing to go on or the call fails. */
  private async wrapUp(run: Run, request: string, instructions: string): Promise<string | null> {
    if (!run.found.length || run.ctrl.signal.aborted) return null;
    let found = "";
    for (const f of [...run.found].reverse()) {
      if (found.length + f.length > FOUND_CHARS) break;
      found = `${f}\n\n${found}`;
    }
    this.opts.log?.write(run.id, { type: "wrap_up", found: run.found.length });
    try {
      const r = await (this.opts.generate ?? generateText)({
        model: this.opts.model,
        instructions: `${instructions}\n\n${WRAP_UP}`,
        messages: [{ role: "user", content: `the user asked: ${request}\n\nWhat your tools found, oldest first:\n\n${found.trim()}` }],
        abortSignal: AbortSignal.any([run.ctrl.signal, AbortSignal.timeout(WRAP_UP_TIMEOUT_MS)]),
        maxRetries: 0,
      } as Parameters<typeof generateText>[0]);
      const said = r.text.trim();
      return said && !TOOL_MARKUP.test(said) ? said : null;
    } catch {
      return null;
    }
  }

  private rememberRun(run: Run, user: string, assistant: string): void {
    if (run.job) return; // the lead remembers the conversation; a job's account goes to the task
    run.chat.append(user, assistant, "brain", run.chatGen);
  }
}

export function createAgentBrain(env: NodeJS.ProcessEnv, opts: { spoken?: boolean; hands: Hands; log?: RunLog; apps?: AppsLoader | null; chat?: ChatStore }): AgentBrain | null {
  const direct = env.JEV_BRAIN_PROVIDER !== "openrouter" && !!env.OPENAI_API_KEY?.trim();
  const apiKey = (direct ? env.OPENAI_API_KEY : env.OPENROUTER_API_KEY)?.trim();
  if (!apiKey) return null;
  const modelId = env.JEV_BRAIN_MODEL?.trim() || (direct ? "gpt-6-luna" : DEFAULT_MODEL);
  // An explicit provider instance — never a bare string, which would go through Vercel's gateway.
  // Low reasoning effort: measured 2026-09-25 on the same bounded Slack run, 4.7s against 21.9s at
  // the default, with the same answer. At the default a late step thought for 20–40s and a run ran
  // out of clock. (Off is refused for this model: "Reasoning is mandatory for this endpoint".)
  const effort = (env.JEV_BRAIN_REASONING?.trim() || "low") as "low";
  const model = direct ? createOpenAI({ apiKey }).responses(modelId) : createOpenRouter({ apiKey }).chat(modelId, { reasoning: { effort } });
  const apps = opts.apps === undefined ? createComposioApps(env) : opts.apps;
  // JEV_CHAT_FILE: another file, or "off" for a chat that lives only as long as the process
  const file = env.JEV_CHAT_FILE?.trim();
  const chat = opts.chat ?? new ChatStore(file === "off" ? null : file || undefined);
  return new AgentBrain({ model, modelId, provider: direct ? "OpenAI" : "OpenRouter", hands: opts.hands, instructions: () => loadBrainInstructions(undefined, { spoken: opts.spoken }), log: opts.log ?? fileRunLog(), apps, chat });
}
