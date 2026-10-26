/** One conversation with one surface: the command → decide → gate → execute loop, plus the
 *  confirm/clarify questions it may leave open. Pure orchestration: no transport, no timers.
 *  Every observable event is emitted as a ServerMessage; hosts (WebSocket hub, HTTP, MCP)
 *  subscribe and forward. Work is serialized per session so replies can't overtake commands. */
import { type Action, describeAction } from "./actions.js";
import { type ApprovalChoice, type Brain, type BrainRun, approvalChoice } from "./brain.js";
import { parseOrdinal, splitSteps } from "./commands.js";
import { type Control, controlRequest, describeControl, isNotRunning, lineKey, lineVars, speakFirst } from "./controls.js";
import { TimerStore, sayDuration } from "./timers.js";
import { line, withoutTags } from "./lines.js";
import { appRequest, fileRequest, isResetCommand, isSleepCommand, isStopWord, talkToCommand, voiceMuteCommand } from "./route.js";
import type { Decider, Decision } from "./decide.js";
import type { PageSnapshot } from "./elements.js";
import type { Executor } from "./executor.js";
import { type Speaker, clipSpoken, spokenPart, spokenSummary } from "./speak.js";
import { resultSummary } from "./summary.js";
import type { DecisionSummary, ServerMessage, StepInfo, TalkTo, VerifySummary } from "./protocol.js";
import type { CommandResult, PendingSummary, SessionStatus, StatusLevel, StepResult } from "./results.js";
import { type VerifyResult, describeVerify } from "./verify.js";

/** A question the browser lane left open. Set and cleared inside the command queue. */
export type Pending =
  | { kind: "confirm"; action: Action; label: string; reason: string; before: PageSnapshot; command: string }
  | { kind: "clarify"; decision: Decision; before: PageSnapshot; command: string }
  | null;

/** The brain asked before doing something; its run waits until a human answers. Lives in its
 *  own slot because it arrives outside the queue and must never clobber (or be clobbered by)
 *  a browser question. A spoken yes/no answers the browser question first; the approval is
 *  spoken once nothing else is waiting. */
export interface ApprovalPending {
  runId: string;
  requestId: string | null;
  summary: string;
  choices: ApprovalChoice[];
}

/** The brain run in progress, if any. Runs outside the command queue so browser commands and
 *  spoken approvals keep flowing while the agent works. */
interface BrainState {
  id: string;
  stepId: number;
  /** What was sent, for a retry. */
  text: string;
  /** 1 = first run for this utterance; a model error re-sends up to MAX_ATTEMPTS times. */
  attempt: number;
  /** Tools the run has started, in order: once one has, a failed run is not re-sent. */
  tools: string[];
  done: Promise<BrainOutcome>;
  resolve: (o: BrainOutcome) => void;
  /** Whether the human who asked was at the panel or the microphone — decided when the run starts,
   *  because the answer arrives long after `withSpeech` has reset. */
  speak: boolean;
  /** Who asked: the co-founder (over the tailnet), not the user. Its approvals say so and are spoken. */
  from?: "cofounder";
  /** Files that came with the message, for a retry. */
  attachments?: Array<{ id: string; name: string }>;
  /** Stopped because the user asked for something himself. */
  preempted?: boolean;
  /** "On it." has been said, or no longer should be (answered, asking, over). */
  acked?: boolean;
  ackTimer?: ReturnType<typeof setTimeout>;
}

/** A run that fails with a model-provider error before any tool ran is re-sent: once on the
 *  same conversation (the provider's errors are mostly transient), then once on a fresh one. */
const MAX_ATTEMPTS = 3;
/** Model failures in a row before the conversation is rotated (its history is then suspect). */
const ROTATE_AFTER_MODEL_FAILURES = 2;
const RETRY_DELAY_MS = 1500;
/** "On it." — a fallback, said once per spoken run only when nothing else has been said by now.
 *  The lead (v11.5) says its own plan line ("Logging into Salesforce to make the app — I'll tell you
 *  when the keys are in place"), which replaces it; measured 2026-09-29 that line comes 4–5s in, and
 *  a plain answer 2.3s in. Live 2026-09-28 the generic line was all he heard, seven times over. */
// The lead's own plan line usually lands 4–8 s in (Luna's first step, measured 2026-09-29); the
// generic line is only for when it doesn't, so it must not beat it.
const ACK_AFTER_MS = 9000;

export interface BrainOutcome {
  ok: boolean;
  output: string;
}

/** The Mac lane's launcher: applications by name, files by name. Acting *inside* an app is the
 *  Mac executor's job (server/executors/mac.ts), reached like any other surface. */
export interface Computer {
  openApp(app: string): Promise<string>;
  /** Files whose name contains `query`, best first, at most a handful. */
  findFiles(query: string): Promise<string[]>;
  openPath(path: string): Promise<string>;
  /** Volume, playback, appearance, power. Optional so an implementation that cannot do it (or a
   *  test's inline stub) degrades to a clear refusal rather than a crash. */
  control?(c: Control): Promise<string>;
}

/** A question to answer, rather than an explicit request to search: "what's the top story on HN",
 *  "who won last night?" — but not "search for cats" or "google the weather". */
export function isQuestion(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/^(hey|ok|okay)?\s*(jev|jeff)[,!.]?\s*/, "");
  if (/\b(search|google|look up|lookup|bing)\b/.test(t)) return false;
  return /\?\s*$/.test(t) || /^(what|what's|whats|who|who's|whos|when|where|why|how|which|is|are|does|do|did|can|could|should|will|would|tell me|explain)\b/.test(t);
}

/** A question that wants an answer, not a polite way of saying "open it". */
export function wantsAnswer(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/^(hey|ok|okay)?\s*(jev|jeff)[,!.]?\s*/, "");
  if (/^(can|could|would|will)\s+you\s+(please\s+)?(open|go\s+to|navigate|launch|show|pull\s+up|bring\s+up|load)\b/.test(t)) return false;
  return isQuestion(t);
}

/** How many file matches are offered before asking is pointless. */
export const MAX_FILE_CHOICES = 5;

/** "Resume 2026.pdf (Documents)" — what is said aloud when asking which file. */
export function fileLabel(path: string): string {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  const folder = parts.pop();
  return folder ? `${name} (${folder})` : name;
}

/** The rest of a multi-step utterance, parked while a confirm/clarify question is open. */
interface Continuation {
  original: string;
  commands: string[];
  /** Index of the step that raised the question; resume from index + 1. */
  index: number;
}

export interface SessionDeps {
  executor: Executor;
  decider: Decider;
  /** Called after every action that may have changed the surface (a host pushes a frame). */
  afterAction?: () => void | Promise<void>;
  /** "off": never check outcomes. Sequences always check (blocking); single commands check
   *  in the background so they stay as fast as before. */
  verify?: "on" | "off";
  /** The agent behind the `hermes` route. Without one, such commands fall back to the browser
   *  action Jev also decided, or to a warning. */
  brain?: Brain | null;
  computer?: Computer | null;
  /** Jev's voice. Without one everything works exactly as before, silently. */
  speaker?: Speaker | null;
  /** Timers, which the SESSION owns rather than the Mac lane: firing one means speaking. */
  timers?: TimerStore | null;
  /** The host's setTimeout. Timers fire OUTSIDE the command queue on purpose — a long browser task
   *  must not delay an alarm — so the host schedules and calls back in, exactly as tasks do. */
  scheduleTimer?: (ms: number, fire: () => void) => void;
  /** Pause before re-sending a failed brain run (tests shorten it). */
  retryDelayMs?: number;
  /** How long a spoken run may go without answering before Jev says "On it." (tests shorten it). */
  ackAfterMs?: number;
  /** "go to sleep": the host switches the assistant off (the hub's pause). */
  onSleep?: () => void;
  /** Who the user is talking to right now, and the switch ("talk to the co-founder" / "back to Jev"). */
  talkingTo?: () => TalkTo;
  onTalkTo?: (to: TalkTo) => void;
  /** Pass the user's words straight to the co-founder. Returns at once with a status line; the reply
   *  is posted to the panel (and spoken) by the host when it lands. */
  toCofounder?: (text: string) => string;
  /** "mute yourself" / "voice on": the host flips Jev's voice (the companion's mute switch). */
  onMute?: (muted: boolean) => void;
}

export function summarize(d: Decision): DecisionSummary {
  return {
    command: d.command,
    intent: d.intent,
    intentConfidence: d.intentConfidence,
    route: d.route,
    routeConfidence: d.routeConfidence,
    action: d.action,
    actionLabel: d.clarify ? d.clarify.question : describeAction(d.action),
    source: d.source,
    model: d.meta.model,
    latencyMs: d.meta.latencyMs,
    inputTokens: d.meta.inputTokens,
    targetConfidence: d.targetConfidence ?? undefined,
    alternatives: d.alternatives.length ? d.alternatives : undefined,
    risky: d.riskProbability,
  };
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Session {
  pending: Pending = null;
  approval: ApprovalPending | null = null;
  private continuation: Continuation | null = null;
  private brain: BrainState | null = null;
  /** Consecutive brain runs that ended in a model error; reset by any other outcome. */
  private modelFailures = 0;
  private nextStepId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private inFlight: AbortController | null = null;
  private busy = false;
  private readonly listeners = new Set<(msg: ServerMessage) => void>();

  constructor(
    readonly id: string,
    private readonly deps: SessionDeps,
  ) {}

  get executor(): Executor {
    return this.deps.executor;
  }

  get decider(): Decider {
    return this.deps.decider;
  }

  subscribe(fn: (msg: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(msg: ServerMessage): void {
    for (const fn of this.listeners) fn(msg);
  }

  /** Announce a step and hand back its result skeleton. */
  private ack(command: string, info?: StepInfo): StepResult {
    const stepId = this.nextStepId++;
    const text = this.origin === "cofounder" ? `🤝 From the co-founder: ${command}` : command;
    this.emit(info ? { type: "transcript_ack", text, stepId, step: info } : { type: "transcript_ack", text, stepId });
    return { stepId, command, decision: null, result: null };
  }

  private report(text: string, level: StatusLevel = "info"): { text: string; level: StatusLevel } {
    this.emit({ type: "status", text, level });
    return { text, level };
  }

  /** Serialize work per session. The queue itself never rejects; callers that await the
   *  returned promise still see the task's own rejection. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      this.busy = true;
      try {
        return await task();
      } finally {
        this.busy = false;
      }
    });
    this.queue = run.catch((err) => this.report(errMsg(err), "error"));
    return run;
  }

  /** The browser question, else the brain's approval request. */
  pendingSummary(): PendingSummary {
    return this.localPendingSummary() ?? this.approvalSummary();
  }

  private localPendingSummary(): PendingSummary {
    const p = this.pending;
    if (!p) return null;
    if (p.kind === "confirm") return { kind: "confirm", actionLabel: p.label, reason: p.reason };
    const c = p.decision.clarify;
    return c ? { kind: "clarify", question: c.question, options: c.options } : null;
  }

  private approvalSummary(): PendingSummary {
    const a = this.approval;
    return a ? { kind: "approval", question: Session.approvalQuestion(this.deps.brain?.name ?? "the assistant", a.summary), choices: a.choices } : null;
  }

  async page(): Promise<{ url: string; title: string }> {
    return { url: this.executor.url, title: await this.executor.title() };
  }

  async status(): Promise<SessionStatus> {
    const page = await this.page();
    const protocol = this.executor.protocol;
    return { id: this.id, kind: this.executor.kind, ...page, busy: this.busy, pending: this.pendingSummary(), capabilities: this.executor.capabilities, ready: this.executor.ready !== false, ...(protocol ? { protocol } : {}) };
  }

  /** A typed command. Resolves when the command has been acted on or has left a question open;
   *  never rejects. With `local`, the brain is never consulted — for callers that are the brain
   *  (its jev_browse tool), so a request can't bounce back into a second run. */
  /** `speak` is OFF by default, and that default is the whole design.
   *
   *  "Everything speaks" means every LANE, not every CALLER. The Monday/Thursday review runs at
   *  09:00 from launchd and Hermes drives jev_browse from Telegram — both would be talking to an
   *  empty room. So only turns a human started by voice or at the panel pass `speak: true`;
   *  /api/* and MCP stay silent, and a task inherits the flag from whoever started it. */
  command(text: string, opts: { local?: boolean; speak?: boolean; from?: "cofounder"; attachments?: Array<{ id: string; name: string }> } = {}): Promise<CommandResult> {
    return this.enqueue(() => this.withSpeech(!!opts.speak, () => this.withLocalOnly(!!opts.local, () => this.withOrigin(opts.from ?? null, () => this.withAttachments(opts.attachments ?? [], () => this.handleCommand(text))))));
  }

  /** Files that came with this message (the panel's 📎). Such a message always goes to the brain. */
  private attachments: Array<{ id: string; name: string }> = [];
  private async withAttachments<T>(files: Array<{ id: string; name: string }>, task: () => Promise<T>): Promise<T> {
    const prev = this.attachments;
    this.attachments = files;
    try {
      return await task();
    } finally {
      this.attachments = prev;
    }
  }

  private speaking = false;
  /** Set the moment anything in this turn speaks, so `finish` can read out the outcome only when a
   *  lane has not already said its own line — a control that says "Muted." must not then also hear
   *  the summary of itself. */
  private spoke = false;
  private async withSpeech<T>(on: boolean, task: () => Promise<T>): Promise<T> {
    const prevSpeaking = this.speaking;
    const prevSpoke = this.spoke;
    this.speaking = on;
    this.spoke = false;
    try {
      return await task();
    } finally {
      this.speaking = prevSpeaking;
      this.spoke = prevSpoke;
    }
  }

  /** Say `text` out loud, if there is a voice AND this turn came from a human at the panel or the
   *  microphone. Never throws and never blocks the step: a voice that fails is a quiet Jev, not a
   *  failed command. `text` keeps its Fish emotion tags — they are delivery for the voice model,
   *  and the tag-free form is what the panel already showed. */
  private async say(text: string): Promise<void> {
    if (!this.speaking) return;
    await this.sayAnyway(text);
  }

  /** Speak without consulting `this.speaking`.
   *
   *  The brain lane needs this: `runBrain` returns as soon as the run is accepted, so `withSpeech`
   *  has already put the flag back by the time the answer arrives minutes later. The decision of
   *  whether THAT run may speak is taken when it starts and carried on its own state. */
  private async sayAnyway(text: string): Promise<void> {
    const speaker = this.deps.speaker;
    if (!speaker || !text.trim()) return;
    this.spoke = true; // set before the first await: `finish` may run while this is still playing
    try {
      // The panel's "she is talking" flag is NOT emitted here: two overlapping lines would each turn
      // it off when they individually finished, and the first to finish would blank the indicator
      // while the second was still playing. The speech gate counts overlapping playbacks for exactly
      // that reason, so it is the one thing that says whether audio is coming out — and it also
      // covers the lines that never pass through a Session at all, like "Yes?".
      await speaker.speak(text);
    } catch {
      /* a voice that fails is a quiet Jev, not a failed command */
    }
  }

  /** Set only INSIDE the queued task of a request from the co-founder — never across an await
   *  outside the queue, or the user's own words typed meanwhile would be labelled as its. The run
   *  itself remembers who asked (BrainState.from). */
  private origin: "cofounder" | null = null;
  private async withOrigin<T>(from: "cofounder" | null, task: () => Promise<T>): Promise<T> {
    const prev = this.origin;
    this.origin = from;
    try {
      return await task();
    } finally {
      this.origin = prev;
    }
  }

  /** A task the co-founder asked Jev to do on the user's Mac, through Jev's own brain and exactly
   *  Jev's approvals — every send, post, delete or unlisted command is asked of the user in his panel
   *  (and aloud), labelled as the co-founder's. It never joins or steers a run the user started: while
   *  Jev is busy for him, the co-founder is told to try again. And the user always comes first: his
   *  own next turn stops the co-founder's run rather than steering it. */
  fromCofounder(task: string): Promise<CommandResult & { output: string }> {
    return this.ask(task, { from: "cofounder" });
  }

  private localOnly = false;
  private async withLocalOnly<T>(on: boolean, task: () => Promise<T>): Promise<T> {
    const prev = this.localOnly;
    this.localOnly = on;
    try {
      return await task();
    } finally {
      this.localOnly = prev;
    }
  }

  /** The brain, unless this command must stay local. */
  private get brainFor(): Brain | null {
    return this.localOnly ? null : (this.deps.brain ?? null);
  }

  /** A command whose answer the caller wants in full: when it reaches the brain, resolves with
   *  the run's final output instead of the "on it" acknowledgement.
   *
   *  `local` forbids the brain lane, exactly as it does on `command`. /api/ask passes it, and the
   *  reason is the recursion it prevents — see the route. */
  async ask(text: string, opts: { local?: boolean; from?: "cofounder" } = {}): Promise<CommandResult & { output: string }> {
    const r = await this.command(text, opts);
    const run = this.brain;
    const started = r.steps.find((s) => run && s.stepId === run.stepId);
    if (!run || !started) return { ...r, output: resultSummary(r) };
    const outcome = await run.done;
    return { ...r, ok: r.ok && outcome.ok, output: outcome.output };
  }

  /** Answer to a pending confirmation from a UI control. */
  reply(ok: boolean, opts: { speak?: boolean } = {}): Promise<CommandResult> {
    return this.enqueue(() => this.withSpeech(!!opts.speak, async () => {
      const pending = this.pending?.kind === "confirm" ? this.pending : null;
      const rest = this.takeContinuation();
      this.pending = null;
      const step = this.ack(ok ? "yes" : "no");
      if (!pending) return this.finish([step]);
      if (!ok) {
        step.result = this.report(`Cancelled: ${pending.label}`, "warn");
        return this.finish([step]);
      }
      await this.runHeld(step, pending.action, pending.before, rest !== null);
      return this.resume([step], rest);
    }));
  }

  /** Answer to a brain approval request from a UI control. */
  approve(choice: ApprovalChoice, opts: { speak?: boolean } = {}): Promise<CommandResult> {
    return this.enqueue(() => this.withSpeech(!!opts.speak, async () => {
      const pending = this.approval;
      const step = this.ack(choice === "deny" ? "no" : `yes (${choice})`);
      if (!pending || !this.deps.brain) return this.finish([step]);
      await this.resolveApproval(step, pending, choice);
      return this.finish([step]);
    }));
  }

  private async resolveApproval(step: StepResult, pending: ApprovalPending, choice: ApprovalChoice): Promise<void> {
    if (this.approval === pending) this.approval = null;
    try {
      await this.deps.brain!.approve(pending.runId, choice, pending.requestId);
      step.result = choice === "deny" ? this.report(`Denied: ${pending.summary}`, "warn") : this.report(`Allowed: ${pending.summary}`, "ok");
    } catch (err) {
      step.result = this.report(`Couldn't answer ${this.deps.brain?.name ?? "the assistant"}: ${errMsg(err)}`, "error");
    }
  }

  /** A clarification option chosen from a UI control. */
  pick(elementId: string, opts: { speak?: boolean } = {}): Promise<CommandResult> {
    return this.enqueue(() => this.withSpeech(!!opts.speak, async () => {
      const pending = this.pending?.kind === "clarify" ? this.pending : null;
      const opt = pending?.decision.clarify?.options.find((o) => o.elementId === elementId);
      const rest = this.takeContinuation();
      this.pending = null;
      const step = this.ack(`pick ${elementId}`);
      if (!pending || !opt) return this.finish([step]);
      await this.runHeld(step, { kind: "click", elementId: opt.elementId, label: opt.label }, pending.before, rest !== null);
      return this.resume([step], rest);
    }));
  }

  /** Click on the live view; fx/fy are fractions of the frame. */
  /** the user's own click, typing or key on the panel's picture. Not queued behind Jev's work and
   *  never decided or gated: it is him. Falls back to the old coordinate click on a surface that
   *  has no input of its own. */
  async inputClick(fx: number, fy: number): Promise<void> {
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) return;
    if (!this.executor.inputClick) return this.clickAt(fx, fy);
    await this.userInput(() => this.executor.inputClick!(fx, fy));
  }

  async inputText(text: string): Promise<void> {
    if (typeof text !== "string" || !text || !this.executor.inputText) return;
    await this.userInput(() => this.executor.inputText!(text));
  }

  async inputKey(key: string): Promise<void> {
    if (typeof key !== "string" || !key || !this.executor.inputKey) return;
    await this.userInput(() => this.executor.inputKey!(key));
  }

  private async userInput(run: () => Promise<string>): Promise<void> {
    try {
      await run();
    } catch (err) {
      this.emit({ type: "status", text: err instanceof Error ? err.message : String(err), level: "warn" });
    }
    await this.deps.afterAction?.();
  }

  clickAt(fx: number, fy: number): Promise<void> {
    return this.enqueue(async () => {
      if (!Number.isFinite(fx) || !Number.isFinite(fy) || !this.executor.capabilities.clickAt) return;
      const { width, height } = this.executor.viewport;
      const x = Math.round(Math.min(1, Math.max(0, fx)) * width);
      const y = Math.round(Math.min(1, Math.max(0, fy)) * height);
      await this.runAction({ kind: "click_at", x, y });
    });
  }

  setViewport(width: number, height: number): Promise<boolean> {
    return this.enqueue(async () => {
      if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
      if (!(await this.executor.setViewport(width, height))) return false;
      this.emit({ type: "viewport", ...this.executor.viewport });
      await this.deps.afterAction?.();
      return true;
    });
  }

  /** Stop talking. Nothing else: the work carries on and the conversation is kept.
   *
   *  In wake mode this is the ONLY way out of a long answer, because the self-hearing gate drops
   *  everything said while she is talking — so "stop" cannot be heard until she has stopped. It is
   *  deliberately NOT `interrupt`: pressing the microphone to add "and also check X" must not cancel
   *  the run that the addition is meant to steer. */
  hush(): void {
    this.deps.speaker?.stop();
  }

  /** Cut Jev off AND cancel the brain's current run. The Stop button, not the Escape key. */
  interrupt(): void {
    this.hush();
    this.stopBrain();
  }

  /** Drop whatever is in flight or pending. Bypasses the queue on purpose. `quiet` skips the
   *  "Stopped" status (a pause announces itself). */
  cancel(quiet = false): void {
    this.deps.speaker?.stop();
    this.inFlight?.abort();
    this.pending = null;
    this.continuation = null;
    this.stopBrain();
    if (!quiet) this.report("Stopped", "ok");
  }

  private stopping = new Set<string>();
  /** Ask the brain to stop its run (once per run); the run's own cancelled event clears state. */
  private stopBrain(): void {
    const run = this.brain;
    if (!run || !this.deps.brain || this.stopping.has(run.id)) return;
    this.stopping.add(run.id);
    this.approval = null;
    this.deps.brain.stop(run.id).catch((err) => this.report(`Couldn't stop ${this.deps.brain?.name ?? "the brain"}: ${errMsg(err)}`, "warn"));
  }

  private async finish(steps: StepResult[], stoppedAt?: number): Promise<CommandResult> {
    const local = this.localPendingSummary();
    // a parked brain approval does not make this command incomplete, but it is the question
    // the caller should hear next
    const ok = local === null && steps.length > 0 && stoppedAt === undefined && steps.every((s) => s.result?.level === "ok" && !s.verify?.stuck);
    const result: CommandResult = { ok, steps, page: await this.page(), pending: local ?? this.approvalSummary() };
    if (stoppedAt !== undefined) result.stoppedAt = stoppedAt;
    // Every command ends here, which makes it the place to read the outcome out — but only when the
    // lane has not spoken for itself. A question is read instead of the outcome, because a question
    // nobody hears is a turn that just stops.
    // `spokenSummary` already reads a confirm, a clarify with its options, or a parked approval in
    // place of the outcome, and deliberately says nothing for a step handed to the brain — that
    // answer speaks for itself when it arrives.
    if (this.speaking && !this.spoke) void this.sayAnyway(spokenSummary(result, this.deps.speaker?.maxChars));
    this.rememberTurn(result);
    return result;
  }

  /** A turn the user gave that Jev answered straight away — "open Slack", a click, a volume change —
   *  goes into the brain's chat too, so "is it open?" or "now send it to Xander" has it in view.
   *  Only his own turns (panel or voice): the review, MCP and the API are not the conversation.
   *  A step handed to the brain is skipped; the brain keeps its own record of that turn. */
  private rememberTurn(result: CommandResult): void {
    const brain = this.deps.brain;
    if (!this.speaking || !brain?.remember || result.steps.length === 0) return;
    if (result.steps.some((s) => s.lane)) return; // the brain keeps its own; the co-founder's is its own chat
    const user = result.steps.map((s) => s.command).join(", then ");
    const outcome = resultSummary(result);
    if (user.trim() && outcome.trim()) brain.remember(user, outcome);
  }

  private async runAction(action: Action): Promise<{ text: string; level: StatusLevel; error: string | null }> {
    this.report(describeAction(action) + "…", "busy");
    let outcome: { text: string; level: StatusLevel; error: string | null };
    try {
      outcome = { ...this.report(await this.executor.execute(action), "ok"), error: null };
    } catch (err) {
      outcome = { ...this.report(errMsg(err), "error"), error: errMsg(err) };
    }
    await this.deps.afterAction?.();
    return outcome;
  }

  private static summarizeVerify(v: VerifyResult): VerifySummary {
    return { done: v.done, stuck: v.stuck, doneProbability: v.doneProbability, blocker: v.blocker, source: v.source, latencyMs: v.meta.latencyMs, text: describeVerify(v) };
  }

  /** Check a step's outcome against a fresh snapshot; never throws. */
  private async verifyStep(step: StepResult, action: Action, before: PageSnapshot, error: string | null): Promise<VerifySummary | null> {
    if (this.deps.verify === "off") return null;
    try {
      const after = await this.executor.snapshot();
      const v = await this.decider.verify({ command: step.command, expectation: null, action, before, after, error });
      const summary = Session.summarizeVerify(v);
      step.verify = summary;
      this.emit({ type: "verify", stepId: step.stepId, command: step.command, verify: summary });
      if (v.meta.fallbackReason) this.report(`Jev unavailable for verification (${v.meta.fallbackReason}); used heuristics`, "warn");
      return summary;
    } catch (err) {
      this.report(`Verification failed: ${errMsg(err)}`, "warn");
      return null;
    }
  }

  private takeContinuation(): Continuation | null {
    const c = this.continuation;
    this.continuation = null;
    return c;
  }

  /** After a held action ran, carry on with the steps parked behind the question. */
  private async resume(steps: StepResult[], rest: Continuation | null): Promise<CommandResult> {
    const last = steps[steps.length - 1];
    const failed = last?.result?.level === "error" || !!last?.verify?.stuck;
    if (failed || !rest) return this.finish(steps, failed && rest ? steps.length - 1 : undefined);
    return this.runSteps(rest.original, rest.commands, rest.index + 1, steps);
  }

  /** Run an action that was waiting on a question, then check it like any other step. */
  private async runHeld(step: StepResult, action: Action, before: PageSnapshot, inSequence: boolean): Promise<void> {
    const blocking = inSequence;
    const outcome = await this.runAction(action);
    step.result = { text: outcome.text, level: outcome.level };
    if (blocking) await this.verifyStep(step, action, before, outcome.error);
    else this.verifySoon(step, action, before, outcome.error);
  }

  /** Verify after the current task, still inside the queue: a snapshot re-tags element ids,
   *  so it must never interleave with another command's snapshot → execute. */
  private verifySoon(step: StepResult, action: Action, before: PageSnapshot, error: string | null): void {
    this.enqueue(() => this.verifyStep(step, action, before, error)).catch(() => {});
  }

  private async handleCommand(text: string): Promise<CommandResult> {
    // a file dropped with no words still means "here, read this"
    const trimmed = text.trim() || (this.attachments.length ? "Read the attached file." : "");
    if (!trimmed) return this.finish([]);

    // Checked here, inside the queue, so nothing can be admitted between the check and the run.
    if (this.origin === "cofounder" && this.brain) {
      const step = this.ack(trimmed);
      step.result = this.report("Jev is busy with something for the user right now. Try again in a minute.", "warn");
      return this.finish([step]);
    }

    // "stop" always wins: it halts the brain run outright rather than answering a question
    if (isStopWord(trimmed)) {
      this.stopBrain();
    }

    const talk = this.deps.onTalkTo ? talkToCommand(trimmed) : null;
    if (talk) {
      const step = this.ack(trimmed);
      this.deps.onTalkTo!(talk);
      step.result = this.report(talk === "cofounder" ? "Talking to the co-founder now — what you say goes straight to it. Say “back to Jev” to switch back." : "Back to Jev.", "ok");
      return this.finish([step]);
    }
    // Co-founder mode: the user's own words (panel or voice — never the API's) go straight to it, with
    // no approval: he is the one writing. Stop, sleep and mute still belong to Jev.
    if (this.speaking && this.deps.toCofounder && this.deps.talkingTo?.() === "cofounder" && !isStopWord(trimmed) && !isSleepCommand(trimmed) && voiceMuteCommand(trimmed) === null) {
      const step = this.ack(trimmed);
      if (isResetCommand(trimmed)) {
        step.result = this.report("The co-founder's Studio can't start a fresh conversation from here yet. Say “back to Jev” to start a new chat with Jev.", "warn");
      } else {
        step.lane = "cofounder";
        step.result = this.report(this.deps.toCofounder(trimmed), "ok");
      }
      return this.finish([step]);
    }

    // A charter or a plan to read is never a quick action: straight to the brain, files and all.
    if (this.attachments.length) {
      // the transcript shows what came with the words
      const step = this.ack(`${trimmed}  ${this.attachments.map((a) => `📎 ${a.name}`).join("  ")}`);
      if (this.brainFor && this.deps.brain) return this.finish([await this.runBrain(step, trimmed)]);
      step.result = this.report("Reading attached files needs the brain, and it isn't set up (no OPENROUTER_API_KEY).", "warn");
      return this.finish([step]);
    }

    if (this.brainFor && isResetCommand(trimmed)) return this.finish([await this.resetBrain(trimmed)]);
    if (this.deps.onSleep && isSleepCommand(trimmed)) {
      const step = this.ack(trimmed);
      this.deps.onSleep();
      step.result = this.report("Okay, going quiet. Paused until ⌥Space, the tray or the panel wakes me.", "ok");
      return this.finish([step]);
    }

    const mute = this.deps.onMute ? voiceMuteCommand(trimmed) : null;
    if (mute !== null) {
      const step = this.ack(trimmed);
      this.deps.onMute!(mute);
      step.result = this.report(mute ? "Muted. I'll answer here in the panel only." : "Voice back on.", "ok");
      return this.finish([step]);
    }

    if (this.approval && !this.pending && this.brainFor && !isStopWord(trimmed)) {
      // a yes/no answers the agent; anything else is a new command and the request stays open
      const pending = this.approval;
      const reply = await this.decider.classifyReply(trimmed, pending.summary);
      if (reply === "confirm" || reply === "cancel") {
        const step = this.ack(trimmed);
        await this.resolveApproval(step, pending, approvalChoice(reply, trimmed, pending.choices));
        return this.finish([step]);
      }
    }
    if (this.pending?.kind === "confirm") {
      const pending = this.pending;
      const reply = await this.decider.classifyReply(trimmed, pending.label);
      if (reply === "confirm" || reply === "cancel") {
        const rest = this.takeContinuation();
        this.pending = null;
        const step = this.ack(trimmed);
        if (reply === "cancel") {
          step.result = this.report(`Cancelled: ${pending.label}`, "warn");
          return this.finish([step]);
        }
        await this.runHeld(step, pending.action, pending.before, rest !== null);
        return this.resume([step], rest);
      }
      this.pending = null; // a new command supersedes the question and whatever was queued behind it
      this.continuation = null;
    }
    if (this.pending?.kind === "clarify") {
      const pending = this.pending;
      const opts = pending.decision.clarify?.options ?? [];
      const idx = parseOrdinal(trimmed);
      const picked = idx !== null ? opts[idx] : undefined;
      const rest = this.takeContinuation();
      this.pending = null;
      if (picked && pending.decision.action.kind === "open_path") {
        // "which file?" answered: the options were paths, not page elements
        const step = this.ack(trimmed);
        const path = pending.decision.action.candidates?.[idx!];
        step.result = path ? await this.runOpenPath(path) : this.report("That wasn't one of the files I offered", "warn");
        return this.resume([step], rest);
      }
      if (picked) {
        const step = this.ack(trimmed);
        await this.runHeld(step, { kind: "click", elementId: picked.elementId, label: picked.label }, pending.before, rest !== null);
        return this.resume([step], rest);
      }
    }

    const commands = splitSteps(trimmed);
    if (commands.length === 0) return this.finish([]);
    if (commands.length > 1) {
      // route the whole utterance first: "find 20 dentists and put them in a sheet" is one
      // task for the brain, not two browser steps — but skip this pre-check when the utterance
      // starts with an obvious app/file open ("open slack and click general"): deciding on the
      // whole joined string would fail to extract an app name from the trailing clause, and
      // even a correct "computer" decision on the combined text runs it as ONE step, silently
      // dropping everything after "and" (fastLane() always treats "computer" as non-splittable).
      // ...or with a device control. "Turn Spotify down and open Slack" starts with a control, so
      // without this the pre-check runs, the whole string decides as `computer`, fastLane() returns
      // false for that route, and the utterance runs as ONE step — "open Slack" silently vanishes.
      // That is the v4 P0 bug reached through a new door, and it is the headline demo for v9.
      const opensAppOrFile = !!appRequest(commands[0]!) || !!fileRequest(commands[0]!) || controlRequest(commands[0]!);
      if (!opensAppOrFile) {
        const decision = await this.decide(trimmed, null);
        if (decision && !this.fastLane(decision)) {
          const step = this.ack(trimmed);
          this.announce(step, decision);
          return this.finish([await this.runStep(step, "async", decision, trimmed)]);
        }
      }
      this.emit({ type: "steps", original: trimmed, commands });
    }
    return this.runSteps(trimmed, commands, 0, []);
  }

  /** Browser steps run one at a time on the fast lane; everything else is handled whole. */
  private fastLane(d: Decision): boolean {
    if (d.route === "stop" || d.route === "computer") return false;
    // Half-heard speech is handled as if there were no brain at all: it never starts a run.
    if (d.route === "unclear") return true;
    if (d.route === "hermes") return !this.brainFor;
    return true;
  }

  /** Run commands[from..] in order. A question parks the remainder; an error or a
   *  non-command stops the sequence. */
  private async runSteps(original: string, commands: string[], from: number, steps: StepResult[]): Promise<CommandResult> {
    const total = commands.length;
    for (let i = from; i < total; i++) {
      const command = commands[i]!;
      const info: StepInfo | undefined = total > 1 ? { index: i, total, original } : undefined;
      const step = await this.runStep(this.ack(command, info), total > 1 ? "blocking" : "async", undefined, total === 1 ? original : undefined, total > 1);
      steps.push(step);
      if (step.verify?.stuck) {
        if (i + 1 < total) this.report(`Stopped after step ${i + 1} of ${total}: ${step.verify.text}`, "warn");
        return this.finish(steps, steps.length - 1);
      }
      if (this.pending) {
        this.continuation = i + 1 < total ? { original, commands, index: i } : null;
        return this.finish(steps, i + 1 < total ? steps.length - 1 : undefined);
      }
      if (step.decision?.action.kind === "stop") return this.finish(steps, steps.length - 1);
      const failed = !step.result || step.result.level === "error" || step.result.level === "warn";
      if (failed) {
        if (i + 1 < total) this.report(`Stopped after step ${i + 1} of ${total}: ${step.result?.text ?? "no result"}`, "warn");
        return this.finish(steps, steps.length - 1);
      }
    }
    return this.finish(steps);
  }

  /** Snapshot taken for the most recent decision; the step that acts on it runs right after. */
  private lastSnapshot: PageSnapshot | null = null;

  /** Decide a command against a fresh snapshot. Returns null on failure, which is reported on
   *  `step` when there is one. */
  private async decide(command: string, step: StepResult | null, pinBrowser = false): Promise<Decision | null> {
    if (step) this.report("Thinking…", "busy");
    this.inFlight?.abort();
    const controller = (this.inFlight = new AbortController());
    const snapshot = (this.lastSnapshot = await this.executor.snapshot());
    let decision: Decision;
    try {
      decision = await this.decider.decide(command, snapshot, controller.signal);
    } catch (err) {
      const outcome = controller.signal.aborted ? this.report("Cancelled", "warn") : this.report(errMsg(err), "error");
      if (step) step.result = outcome;
      return null;
    }
    // a step of an utterance already routed to the browser stays there: "search for cats" on
    // its own may read as a question, but here it is the second half of a page sequence
    if (pinBrowser && (decision.route === "hermes" || decision.route === "unclear") && decision.action.kind !== "none") decision.route = "browser_now";
    // A question is for the brain, not for Google. The fast lane's "plain web search" was the right
    // call when Jev had no brain to answer; with one, "what's the top story on Hacker News" opened a
    // search tab in his Chrome instead of being answered. An explicit "search / google / look up"
    // still searches.
    // Same for a question that names a site: "what are the top stories on news.ycombinator.com?"
    // decided as navigate, and live 2026-09-29 it opened HN in his visible tab and answered nothing.
    // "can you open gmail?" is a request, not a question, and stays instant.
    const asks = decision.action.kind === "search" ? isQuestion(command) : decision.action.kind === "navigate" && wantsAnswer(command);
    if (!pinBrowser && this.brainFor && decision.route === "browser_now" && asks) {
      decision.route = "hermes";
      decision.action = { kind: "none", reason: "a question for the brain" };
    }
    if (step) this.announce(step, decision);
    return decision;
  }

  private announce(step: StepResult, decision: Decision): void {
    step.decision = summarize(decision);
    if (decision.route === "hermes" && this.brainFor) step.decision.actionLabel = `Ask ${this.brainFor.name}`;
    this.emit({ type: "decision", decision: step.decision });
    if (decision.meta.fallbackReason) this.report(`Jev unavailable (${decision.meta.fallbackReason}); used heuristics`, "warn");
  }

  /** One command: decide (unless already decided), gate, execute, check. May leave `pending` set. */
  private async runStep(step: StepResult, verifyMode: "blocking" | "async", decided?: Decision, raw?: string, pinBrowser = false): Promise<StepResult> {
    const command = step.command;
    const decision = decided ?? (await this.decide(command, step, pinBrowser));
    if (!decision) return step;
    const snapshot = this.lastSnapshot!;
    // the brain gets what was actually said (case, names), not the normalised browser form
    const said = raw ?? command;

    if (decision.route === "stop" || decision.action.kind === "stop") {
      this.pending = null;
      this.continuation = null;
      this.stopBrain();
      step.result = this.report("Stopped", "ok");
      return step;
    }
    // `unclear` NEVER reaches the brain. v3 sent half-heard fragments there ("no dead ends"), and
    // live that meant an aside said near the microphone started a run that acted on the Mac. A
    // fragment gets the same answer it would get with no brain configured.
    if (decision.route === "hermes" && this.brainFor) return this.runBrain(step, said);
    // Before open_app and open_path: a control names an app ("turn Spotify down") without being a
    // request to open it, and every one of these used to fall through to the brain, which has no
    // hands for them.
    if (decision.control) {
      step.result = await this.runControl(decision.control);
      return step;
    }
    if (decision.action.kind === "open_app") {
      if (!this.deps.computer) {
        if (this.brainFor) return this.runBrain(step, said);
        step.result = this.report(`I can't open apps from here yet (${decision.action.app})`, "warn");
        return step;
      }
      const outcome = await this.runComputer(decision.action.app);
      step.result = { text: outcome.text, level: outcome.level };
      return step;
    }
    if (decision.action.kind === "open_path") {
      if (!this.deps.computer) {
        if (this.brainFor) return this.runBrain(step, said);
        step.result = this.report(`I can't open files from here yet (${decision.action.query})`, "warn");
        return step;
      }
      return this.runFile(step, decision, snapshot, command, said);
    }
    if (decision.clarify) {
      this.pending = { kind: "clarify", decision, before: snapshot, command };
      this.emit({ type: "clarify", question: decision.clarify.question, options: decision.clarify.options });
      return step;
    }
    if (decision.action.kind === "none") {
      step.result = this.report(decision.route === "hermes" && this.localOnly ? "That needs the assistant, not the browser: ask the user directly" : decision.action.reason, "warn");
      return step;
    }
    if (decision.needsConfirmation) {
      const label = describeAction(decision.action);
      const reason = `This looks hard to undo (risk ${Math.round(decision.riskProbability * 100)}%). Say "yes" or "no".`;
      this.pending = { kind: "confirm", action: decision.action, label, reason, before: snapshot, command };
      this.emit({ type: "confirm", actionLabel: label, reason });
      return step;
    }
    const outcome = await this.runAction(decision.action);
    step.result = { text: outcome.text, level: outcome.level };
    if (verifyMode === "blocking") await this.verifyStep(step, decision.action, snapshot, outcome.error);
    else this.verifySoon(step, decision.action, snapshot, outcome.error);
    return step;
  }

  /** "open my resume": code searches, exactly one match opens, a few matches become a question
   *  ("first", "the second one"), none go to the brain, which can look harder. */
  private async runFile(step: StepResult, decision: Decision, snapshot: PageSnapshot, command: string, said: string): Promise<StepResult> {
    const query = decision.action.kind === "open_path" ? decision.action.query : "";
    this.report(`Looking for ${query}…`, "busy");
    let found: string[];
    try {
      found = (await this.deps.computer!.findFiles(query)).slice(0, MAX_FILE_CHOICES);
    } catch (err) {
      step.result = this.report(errMsg(err), "error");
      return step;
    }
    if (found.length === 0) {
      if (this.brainFor) return this.runBrain(step, said);
      step.result = this.report(`I couldn't find a file called ${query}`, "warn");
      return step;
    }
    if (found.length === 1) {
      step.result = await this.runOpenPath(found[0]!);
      return step;
    }
    const options = found.map((path, i) => ({ elementId: `file:${i}`, label: fileLabel(path), probability: 0 }));
    // the options are read out after the question by spokenSummary, in this order
    const question = `I found ${found.length} files called ${query}. Which one:`;
    decision.action = { kind: "open_path", query, candidates: found };
    decision.clarify = { question, options };
    this.pending = { kind: "clarify", decision, before: snapshot, command };
    this.emit({ type: "clarify", question, options });
    return step;
  }

  private async runOpenPath(path: string): Promise<{ text: string; level: StatusLevel }> {
    try {
      return this.report(await this.deps.computer!.openPath(path), "ok");
    } catch (err) {
      return this.report(errMsg(err), "error");
    }
  }

  /** Run a device control, speaking its scripted line FIRST when the action would otherwise make
   *  the reply inaudible — muting the speaker, or locking/sleeping the screen. Straight from
   *  hey-jev's SPEAK_FIRST, which exists because she muted herself mid-sentence. */
  /** Timers, handled here and never handed to `Computer.control`: a timer is not a Mac capability,
   *  and firing one means speaking. */
  private async runTimer(control: Extract<Control, { target: "timer" }>): Promise<{ text: string; level: StatusLevel }> {
    const store = this.deps.timers;
    if (!store) return this.report("I can't set timers yet.", "warn");
    const publish = () => this.emit({ type: "timers", timers: store.active().map((t) => ({ id: t.id, dueAt: t.dueAt, label: t.label })) });

    if (control.action === "check") {
      const next = store.active()[0];
      const said = next ? line("timer_check", { left: sayDuration(store.remaining(next)) }) : line("timer_none");
      void this.say(said);
      return this.report(withoutTags(said), next ? "ok" : "warn");
    }
    if (control.action === "cancel_all") {
      const n = store.cancelAll();
      const said = line(n ? "timers_cancel" : "timer_none");
      publish();
      void this.say(said);
      return this.report(withoutTags(said), n ? "ok" : "warn");
    }
    if (control.action === "cancel") {
      const gone = store.cancel();
      const said = line(gone ? "timer_cancel" : "timer_none");
      publish();
      void this.say(said);
      return this.report(withoutTags(said), gone ? "ok" : "warn");
    }

    const seconds = control.seconds;
    if (!seconds) return this.report(withoutTags(line("timer_unclear")), "warn");
    const timer = store.add(seconds, control.label ?? null);
    // Render the ALERT while the timer runs, so firing is instant rather than a synthesis the user
    // waits through. Straight from hey-jev's prepare_reminder.
    const alert = timer.label ? line("reminder_done", { label: timer.label }) : line("timer_done");
    // same reason as the wake line: a bare `void` on a rejecting promise exits Node
    void this.deps.speaker?.prepare?.(alert)?.catch?.(() => {});
    // Whether the alert may speak is decided NOW, when a human set the timer. It fires minutes later
    // from outside the command queue, by which time `this.speaking` is long since false — so `say`
    // would have swallowed every alert, and a timer that never says anything is not a timer.
    const aloud = this.speaking;
    this.deps.scheduleTimer?.(seconds * 1000, () => {
      if (!store.fire().some((t) => t.id === timer.id)) return; // cancelled while it ran
      publish();
      this.report(withoutTags(alert), "ok");
      if (aloud) void this.sayAnyway(alert);
    });
    publish();
    const said = `${line(timer.label ? "reminder_set" : "timer_set")} ${sayDuration(seconds)}${timer.label ? `: ${timer.label}` : ""}.`;
    void this.say(said);
    return this.report(withoutTags(said), "ok");
  }

  private async runControl(control: Control): Promise<{ text: string; level: StatusLevel }> {
    if (control.target === "timer") return this.runTimer(control);
    const computer = this.deps.computer;
    if (!computer?.control) return this.report(`I can't ${describeControl(control).toLowerCase()} on this machine yet.`, "warn");
    // Two forms of the same line: `spoken` keeps Fish's emotion tags, `shown` drops them. Anything
    // a person READS — the panel, /api/ask, Hermes over MCP — gets `shown`; only the speaker ever
    // sees the tags. M5 speaks `spoken` directly rather than re-deriving it from the status text,
    // because resultSummary's "Done. " prefix would turn a pre-rendered line into a cache miss.
    const spoken = line(lineKey(control), lineVars(control));
    const shown = withoutTags(spoken);
    // SPEAK_FIRST: muting, locking and sleeping all make the reply inaudible if it comes after.
    // M5 gives `say` a voice; until then this is the same ordering with the panel's status line,
    // so the sequencing is already under test rather than being bolted on later.
    if (speakFirst(control)) this.report(shown, "ok");
    try {
      await computer.control(control);
      return speakFirst(control) ? { text: shown, level: "ok" } : this.report(shown, "ok");
    } catch (err) {
      // "Spotify isn't open" is not a failure — Jev heard correctly and found nothing to act on.
      // Reporting it as an error would suggest something broke; reporting nothing at all would be
      // the silent success this whole branch exists to avoid.
      return this.report(errMsg(err), isNotRunning(err) ? "warn" : "error");
    }
  }

  private async runComputer(app: string): Promise<{ text: string; level: StatusLevel }> {
    this.report(`Opening ${app}…`, "busy");
    try {
      return this.report(await this.deps.computer!.openApp(app), "ok");
    } catch (err) {
      return this.report(errMsg(err), "error");
    }
  }

  static approvalQuestion(name: string, summary: string): string {
    return `${name} wants to ${summary}. Allow it?`;
  }

  /** "new conversation": stop what the brain is doing and give it a clean thread. */
  private async resetBrain(text: string): Promise<StepResult> {
    const brain = this.deps.brain!;
    const step = this.ack(text);
    this.stopBrain();
    this.modelFailures = 0;
    try {
      await brain.reset();
      step.lane = "brain";
      step.result = this.report("New chat — the earlier conversation is closed", "ok");
      this.emit({ type: "new_chat", stepId: step.stepId });
    } catch (err) {
      step.result = this.report(`Couldn't reset ${brain.name}: ${errMsg(err)}`, "error");
    }
    return step;
  }

  /** Hand the utterance to the brain. The step resolves as soon as the run is admitted (or
   *  steered into the run already in progress); events stream in afterwards, outside the queue. */
  private async runBrain(step: StepResult, text: string): Promise<StepResult> {
    const brain = this.deps.brain!;
    // the user comes first: his own turn stops a run the co-founder asked for, instead of steering
    // his words into it.
    if (this.brain && this.brain.from === "cofounder" && this.origin !== "cofounder") {
      const theirs = this.brain;
      theirs.preempted = true;
      this.stopBrain();
      const until = Date.now() + 5_000;
      while (this.brain === theirs && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      if (this.brain === theirs) {
        step.result = this.report(`Couldn't stop the co-founder's request to start yours — say "stop", then ask again.`, "error");
        return step;
      }
      this.report("Stopped the co-founder's request to do yours.", "warn");
    }
    if (this.brain) {
      try {
        // a file dropped mid-run travels as its name and id: the lead opens it with read_doc
        const files = this.attachments.length ? `\n[attached: ${this.attachments.map((f) => `${f.name} (${f.id})`).join(", ")} — read it with read_doc]` : "";
        await brain.steer(this.brain.id, `${text}${files}`);
        step.lane = "brain";
        step.result = this.report(`Told ${brain.name}: ${text}`, "ok");
      } catch (err) {
        step.result = this.report(`Couldn't reach ${brain.name}: ${errMsg(err)}`, "error");
      }
      return step;
    }
    this.report(`Asking ${brain.name}…`, "busy");
    let run: BrainRun;
    try {
      run = await brain.send(text, { ...(this.origin ? { from: this.origin } : {}), ...(this.attachments.length ? { attachments: this.attachments } : {}) });
    } catch (err) {
      step.result = this.report(`${brain.name} unreachable: ${errMsg(err)}`, "error");
      return step;
    }
    let resolve!: (o: BrainOutcome) => void;
    const done = new Promise<BrainOutcome>((r) => (resolve = r));
    const state: BrainState = { id: run.id, stepId: step.stepId, text, attempt: 1, tools: [], done, resolve, speak: this.speaking, ...(this.origin ? { from: this.origin } : {}), ...(this.attachments.length ? { attachments: this.attachments } : {}) };
    this.brain = state;
    if (state.speak) state.ackTimer = setTimeout(() => this.sayOnIt(state), this.deps.ackAfterMs ?? ACK_AFTER_MS);
    void this.consumeBrain(run, state);
    step.lane = "brain";
    step.result = this.report(`${brain.name} is on it`, "ok");
    return step;
  }

  /** A model-provider error on a run that had not started any tool: send the same utterance
   *  again — same conversation first, a fresh one after that — with the outcome still owed to
   *  the original step. Returns false when the run is to be given up on. */
  private async retryBrain(state: BrainState, error: string): Promise<boolean> {
    const brain = this.deps.brain;
    if (!brain || state.tools.length || state.attempt >= MAX_ATTEMPTS || this.stopping.has(state.id)) return false;
    const fresh = state.attempt >= 2 || this.modelFailures >= ROTATE_AFTER_MODEL_FAILURES;
    this.report(`${brain.name}'s model errored (${error}); trying again${fresh ? " in a fresh conversation" : ""}`, "warn");
    await new Promise((r) => setTimeout(r, this.deps.retryDelayMs ?? RETRY_DELAY_MS));
    if (this.stopping.has(state.id) || this.brain !== state) return false;
    let run: BrainRun;
    try {
      run = await brain.send(state.text, { fresh, ...(state.from ? { from: state.from } : {}), ...(state.attachments ? { attachments: state.attachments } : {}) });
    } catch (err) {
      this.report(`${brain.name} unreachable: ${errMsg(err)}`, "error");
      return false;
    }
    if (fresh) this.modelFailures = 0;
    const next: BrainState = { ...state, id: run.id, attempt: state.attempt + 1, tools: [] };
    this.brain = next;
    this.emit({ type: "brain_event", stepId: state.stepId, runId: run.id, event: { kind: "retrying", attempt: next.attempt, fresh } });
    void this.consumeBrain(run, next);
    return true;
  }

  /** Say "On it." once for a spoken run that is taking a while — nothing at all was said between
   *  the user finishing his sentence and the whole run ending, which is most of why it felt slow. */
  private sayOnIt(state: BrainState): void {
    if (!state.speak || state.acked) return;
    this.noAck(state);
    void this.sayAnyway(line("working"));
  }

  private noAck(state: BrainState): void {
    state.acked = true;
    if (state.ackTimer) clearTimeout(state.ackTimer);
    state.ackTimer = undefined;
  }

  /** What to say when a run's model gave up for good. The chat is never dropped for this — only
   *  the user ends a chat — so the line never claims a fresh start. */
  private modelFailureLine(name: string, state: BrainState): string {
    if (state.attempt > 1) return `${name}'s model keeps erroring, even without the earlier chat in view. Give it a moment and say it again.`;
    const after = state.tools.length ? ` after ${state.tools[state.tools.length - 1]!.replace(/_/g, " ")}` : "";
    return `${name} hit an error from its model${after}. Say it again and I'll retry.`;
  }

  /** Forward every run event to the UIs. Statuses stay "busy" so they never claim a later
   *  step's outcome. */
  private async consumeBrain(run: BrainRun, state: BrainState): Promise<void> {
    const name = this.deps.brain?.name ?? "the brain";
    let settled = false;
    const settle = (o: BrainOutcome) => {
      settled = true;
      this.noAck(state);
      state.resolve(o);
    };
    let handedOver = false;
    try {
      for await (const event of run.events) {
        this.emit({ type: "brain_event", stepId: state.stepId, runId: run.id, event });
        switch (event.kind) {
          case "say":
            // the lead's own progress line, spoken as it comes; it replaces the generic "On it."
            this.noAck(state);
            if (state.speak) void this.sayAnyway(clipSpoken(event.text, Math.max(this.deps.speaker?.maxChars ?? 0, 240)));
            this.report(`${name}: ${event.text}`, "busy");
            break;
          case "tool_start":
            state.tools.push(event.tool);
            this.report(`${name}: ${event.tool}…`, "busy");
            break;
          case "approval":
            this.noAck(state); // the question is what gets said
            {
              // The co-founder's requests say whose they are, and are always asked aloud: nobody
              // at the panel started them, so nobody is watching for the card.
              const summary = state.from === "cofounder" ? `${event.summary} (the co-founder asked)` : event.summary;
              this.approval = { runId: run.id, requestId: event.requestId, summary, choices: event.choices };
              // Asked aloud on a spoken run: a write that waits silently on a card nobody is looking
              // at just looks like the brain hung. "yes" / "no" answer it (handleCommand's approval branch).
              if (state.speak || state.from === "cofounder") void this.sayAnyway(Session.approvalQuestion(name, summary));
            }
            break;
          case "approved":
            if (this.approval?.runId === run.id) this.approval = null;
            break;
          case "completed":
            this.modelFailures = 0;
            // The one outcome with no report() choke point: consumeBrain only settles and emits, so
            // this is spoken explicitly, and from the run's own permission rather than this.speaking
            // (which was put back the moment the run was accepted).
            if (state.speak) void this.sayAnyway(spokenPart(event.output, this.deps.speaker?.maxChars));
            settle({ ok: true, output: event.output });
            break;
          case "failed": {
            if (!event.providerFailure) {
              this.modelFailures = 0;
              // Out loud as well: silence is how a spoken turn reports "still working", so a failure
              // that only reaches the panel is a question left hanging in the air.
              if (state.speak) void this.sayAnyway(clipSpoken(`${name} couldn't finish that: ${event.error}`, this.deps.speaker?.maxChars));
              settle({ ok: false, output: event.error });
              break;
            }
            this.modelFailures++;
            if (await this.retryBrain(state, event.error)) {
              handedOver = true;
              break;
            }
            // giving up on this utterance. The chat stays: the next retry after repeated errors is
            // sent without it (retryBrain's `fresh`), but ending the chat is the user's call alone.
            const line = this.modelFailureLine(name, state);
            this.report(line, "error");
            // Said out loud too: a spoken turn that fails silently looks exactly like one still working.
            if (state.speak) void this.sayAnyway(clipSpoken(line, this.deps.speaker?.maxChars));
            settle({ ok: false, output: line });
            break;
          }
          case "cancelled":
            settle({ ok: false, output: state.preempted ? "the user needed Jev for something himself, so this was stopped. Try again in a few minutes." : "Cancelled" });
            break;
        }
      }
    } catch (err) {
      this.emit({ type: "brain_event", stepId: state.stepId, runId: run.id, event: { kind: "failed", error: errMsg(err) } });
      settle({ ok: false, output: errMsg(err) });
    } finally {
      if (!handedOver) {
        if (!settled) settle({ ok: false, output: "The run ended without an answer" });
        if (this.brain === state) this.brain = null;
      }
      if (this.approval?.runId === run.id) this.approval = null;
      this.stopping.delete(run.id);
    }
  }
}
