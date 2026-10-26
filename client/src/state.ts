/** All UI state in one place, derived purely from server messages + local events. */
import type { ApprovalChoice, BrainEvent } from "../../core/brain.ts";
import type { BridgeInfo, CofounderExchange, DecisionSummary, ListenSettings, ServerMessage, SttMode, TalkTo, VerifySummary, VoiceInfo } from "../../core/protocol.ts";

export type StatusLevel = Extract<ServerMessage, { type: "status" }>["level"];

export interface LogEntry {
  id: number;
  /** Server-side step id; verify messages refer to it. */
  stepId?: number;
  said: string;
  /** Set when this entry is one step of a longer utterance. */
  step?: { index: number; total: number; original: string };
  decision: DecisionSummary | null;
  result: { text: string; level: StatusLevel } | null;
  verify?: VerifySummary;
  /** Set once the step went to the brain: what it has said and done so far. */
  brain?: BrainProgress;
  /** This command started a new chat: the transcript draws a line above it. */
  newChat?: true;
  /** From before Jev last restarted (restored from this window's storage). Step ids start over on
   *  every launch, so these never take events meant for a new step. */
  past?: true;
}

export interface BrainProgress {
  runId: string;
  /** The assistant's reply, streamed. */
  text: string;
  tools: Array<{ tool: string; preview: string; durationMs?: number; error?: boolean }>;
  state: "running" | "waiting" | "completed" | "failed" | "cancelled";
  /** Times the utterance was re-sent after a model error, and whether that moved to a fresh conversation. */
  retries?: number;
  fresh?: boolean;
}

export type Pending =
  | { kind: "confirm"; actionLabel: string; reason: string }
  | { kind: "clarify"; question: string; options: Array<{ elementId: string; label: string; probability: number }> }
  | null;

/** The brain's open approval request; independent of the browser question so neither hides the other. */
export type Approval = { runId: string; question: string; choices: ApprovalChoice[] } | null;

export interface State {
  connected: boolean;
  jev: { enabled: boolean; model: string | null } | null;
  /** Switched off: nothing is heard, said or done until resumed. */
  paused: boolean;
  viewport: { width: number; height: number };
  /** "Your screen": the latest picture, when it arrived (`at`), and why there's none (`problem`). */
  page: { url: string; title: string; frame: string | null; at?: number; problem?: { reason: string; at: number } | null };
  /** Where Jev is working in its own minimized Chrome window — never pictured, so said in words. */
  jevChrome: { action: string; url: string | null; at: number } | null;
  status: { text: string; level: StatusLevel };
  entries: LogEntry[];
  pending: Pending;
  approval: Approval;
  /** Running timers, soonest first. `dueAt` is absolute, so the panel counts down itself. */
  timers: Array<{ id: number; dueAt: number; label: string | null }>;
  /** True while Jev's voice is playing. */
  speaking: boolean;
  /** How Jev listens, and whether always-on is possible here. The server owns the choice. */
  listen: ListenSettings;
  /** Whether Jev has a voice, and which. Null until the first hello. */
  voice: VoiceInfo | null;
  /** Jev's own browser, live and clickable (browser-box's player); null when there is none. */
  browserView: string | null;
  /** The co-founder's Orgo computer, or why Jev can't show it; null until the server says. */
  cofounder: { computer: string } | { off: string } | null;
  /** The connected Chrome extension, or null when none is. */
  bridge: BridgeInfo;
  /** How to open the co-founder's live desktop — memory only, never logged (it holds the password). */
  cofounderView: { wsUrl: string; password: string } | { error: string } | null;
  cofounderFrame: { jpegBase64: string | null; error?: string } | null;
  /** Who the user's words go to: Jev, or straight to the co-founder. */
  talkingTo: TalkTo;
  /** The co-founder tab's chat, as last read from the Studio. */
  cofounderHistory: { exchanges: CofounderExchange[] } | { error: string } | null;
  /** Which view fills the big pane. It follows the brain's tools (browser_box → Jev's browser,
   *  mac_* / chrome → your screen) unless the user picked one by hand during this run. */
  pane: { tab: PaneTab; manual: boolean; runId: string | null };
}

export type PaneTab = "browser" | "screen" | "cofounder";

/** A chrome tool call, from its preview (the arguments as JSON, clipped): which window, what it did. */
export function chromeWhere(preview: string): { background: boolean; action: string; url: string | null } {
  const tab = /"tab":"(\w+)"/.exec(preview)?.[1];
  const action = /"action":"(\w+)"/.exec(preview)?.[1] ?? "working";
  const url = /"url":"([^"]+)"/.exec(preview)?.[1] ?? null;
  return { background: tab !== "his_tab", action, url };
}

/** Which view a tool's work shows up in. Connectors and the shell have no window: leave the pane.
 *  Chrome in Jev's own (minimized) window has no picture either — the pane stays where it is and a
 *  line says where Jev is working. Live 2026-09-28 it jumped to "Your screen" and showed Finder. */
export function paneForTool(tool: string, preview = ""): PaneTab | null {
  if (tool === "browser_box") return "browser";
  if (tool === "chrome") return chromeWhere(preview).background ? null : "screen";
  if (tool.startsWith("mac_")) return "screen";
  if (tool === "cofounder" || tool === "orgo") return "cofounder";
  return null;
}

export type Event =
  | ServerMessage
  | { type: "socket"; connected: boolean }
  | { type: "clear_log" }
  | { type: "restore_log"; entries: unknown }
  | { type: "dismiss_pending" }
  | { type: "dismiss_approval" }
  /** The switch was clicked. Applied locally at once so it answers the click; the server remembers
   *  it and confirms it in the next hello. */
  | { type: "listen_mode_local"; mode: SttMode }
  /** the user picked a tab: it stays until the next brain run starts. */
  | { type: "pane_tab"; tab: PaneTab };

export const initialState: State = {
  connected: false,
  jev: null,
  paused: false,
  viewport: { width: 1280, height: 800 },
  page: { url: "about:blank", title: "", frame: null },
  jevChrome: null,
  status: { text: "Connecting…", level: "info" },
  entries: [],
  pending: null,
  approval: null,
  timers: [],
  speaking: false,
  listen: { mode: "push", wakeAvailable: false },
  voice: null,
  browserView: null,
  cofounder: null,
  bridge: null,
  cofounderView: null,
  cofounderFrame: null,
  talkingTo: "jev",
  cofounderHistory: null,
  pane: { tab: "screen", manual: false, runId: null },
};

const MAX_ENTRIES = 40;
let nextId = 1;

/** Patch the newest command of this launch — not a notice that arrived since, not a restored entry. */
function updateLatest(entries: LogEntry[], patch: (e: LogEntry) => LogEntry): LogEntry[] {
  const idx = entries.findIndex((e) => !e.past && e.stepId !== undefined);
  if (idx === -1) return entries;
  const next = entries.slice();
  next[idx] = patch(next[idx]!);
  return next;
}

/** The entry for a step of THIS launch (restored entries share its numbers). */
const stepIndex = (entries: LogEntry[], stepId: number) => entries.findIndex((e) => !e.past && e.stepId === stepId);

/** Entries saved before a restart, made safe to show again: marked past, given ids that can't
 *  collide with this launch's, and an answer that was still coming shown as stopped. */
export function restoredEntries(saved: unknown): LogEntry[] {
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((e): e is LogEntry => !!e && typeof e === "object" && typeof (e as LogEntry).said === "string")
    .slice(0, MAX_ENTRIES)
    .map((e, i) => {
      const brain = e.brain && (e.brain.state === "running" || e.brain.state === "waiting") ? { ...e.brain, state: "cancelled" as const } : e.brain;
      return { ...e, id: -(i + 1), past: true as const, ...(brain ? { brain } : {}), result: e.result ?? (brain?.state === "cancelled" ? { text: "Stopped — Jev restarted", level: "warn" as const } : null) };
    });
}

const MAX_BRAIN_TEXT = 4000;

function progress(entry: LogEntry, runId: string, event: BrainEvent): BrainProgress {
  const p: BrainProgress = entry.brain ?? { runId, text: "", tools: [], state: "running" };
  switch (event.kind) {
    case "delta":
      return { ...p, text: (p.text + event.text).slice(-MAX_BRAIN_TEXT), state: "running" };
    case "tool_start":
      return { ...p, tools: [...p.tools, { tool: event.tool, preview: event.preview }], state: "running" };
    case "tool_end": {
      const tools = p.tools.slice();
      for (let i = tools.length - 1; i >= 0; i--) {
        if (tools[i]!.tool === event.tool && tools[i]!.durationMs === undefined) {
          tools[i] = { ...tools[i]!, durationMs: event.durationMs, error: event.error };
          break;
        }
      }
      return { ...p, tools };
    }
    case "approval":
      return { ...p, state: "waiting" };
    case "approved":
    case "steered":
      return { ...p, state: "running" };
    case "say":
      // said aloud mid-run: kept in the timeline so the panel shows what was said
      return { ...p, tools: [...p.tools, { tool: "said", preview: event.text, durationMs: 0 }] };
    case "completed":
      return { ...p, text: event.output || p.text, state: "completed" };
    case "failed":
      return { ...p, text: p.text ? `${p.text}\n\n${event.error}` : event.error, state: "failed" };
    case "retrying":
      // the same step, a new run: start its text over, keep the tool history for the record
      return { ...p, runId, text: "", state: "running", retries: (p.retries ?? 0) + 1, fresh: event.fresh || !!p.fresh };
    case "cancelled":
      return { ...p, state: "cancelled" };
    default:
      return p;
  }
}

/** Brain events attach to their step's entry by id (they land while later commands run) and
 *  drive the approval card; the final answer becomes the entry's outcome. */
function applyBrainEvent(state: State, stepId: number, runId: string, event: BrainEvent): State {
  const idx = stepIndex(state.entries, stepId);
  let entries = state.entries;
  if (idx !== -1) {
    entries = entries.slice();
    const entry = entries[idx]!;
    const brain = progress(entry, runId, event);
    const result =
      event.kind === "completed"
        ? { text: firstLine(event.output) || "Done", level: "ok" as const }
        : event.kind === "failed"
          ? { text: event.error, level: "error" as const }
          : event.kind === "cancelled"
            ? { text: "Cancelled", level: "warn" as const }
            : event.kind === "retrying"
              ? { text: event.fresh ? "Retrying in a fresh conversation…" : "Retrying…", level: "warn" as const }
              : entry.result;
    entries[idx] = { ...entry, brain, result };
  }
  let approval = state.approval;
  let status = state.status;
  if (event.kind === "approval") {
    approval = { runId, question: `Jev wants to ${event.summary}. Allow it?`, choices: event.choices };
    status = { text: "Brain is waiting for your approval", level: "warn" };
  } else if (approval?.runId === runId && (event.kind === "approved" || event.kind === "completed" || event.kind === "failed" || event.kind === "cancelled")) {
    approval = null;
  }
  if (event.kind === "completed") status = { text: "Brain: done", level: "ok" };
  // Whose fault it was is the most useful thing this line can carry. `Brain: HTTP 500: Internal
  // Server Error (ref: …)` reads as if Jev broke or the task was impossible; it was neither — the
  // model provider behind the assistant fell over, and a retry is already on its way.
  else if (event.kind === "failed") status = { text: event.providerFailure ? `Brain: the model provider failed — ${event.error}` : `Brain: ${event.error}`, level: "error" };
  else if (event.kind === "retrying") status = { text: event.fresh ? "Brain: retrying in a fresh conversation…" : "Brain: retrying…", level: "warn" };
  else if (event.kind === "cancelled") status = { text: "Brain: stopped", level: "warn" };
  return { ...state, entries, approval, status };
}


function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/).find((l) => l.trim()) ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

export function reducer(state: State, ev: Event): State {
  switch (ev.type) {
    case "socket":
      return { ...state, connected: ev.connected, status: ev.connected ? { text: "Connected", level: "ok" } : { text: "Disconnected — retrying…", level: "warn" } };
    case "hello": {
      const browserView = ev.browserView === undefined ? state.browserView : ev.browserView;
      // Jev's browser is the default view when there is one; without it, only the screen exists
      const tab: PaneTab = !browserView ? "screen" : state.pane.manual ? state.pane.tab : state.browserView === null ? "browser" : state.pane.tab;
      return { ...state, jev: ev.jev, viewport: ev.viewport, paused: !!ev.paused, listen: ev.listen ?? state.listen, voice: ev.voice ?? state.voice, browserView, cofounder: ev.cofounder ?? state.cofounder, bridge: ev.bridge === undefined ? state.bridge : ev.bridge, talkingTo: ev.talkingTo ?? state.talkingTo, pane: { ...state.pane, tab } };
    }
    case "listen_mode_local":
      return { ...state, listen: { ...state.listen, mode: ev.mode } };
    case "timers":
      return { ...state, timers: ev.timers };
    case "speaking":
      return { ...state, speaking: ev.active };
    case "voice":
      return { ...state, voice: ev.voice };
    case "bridge":
      return { ...state, bridge: ev.bridge };
    case "talking_to":
      return { ...state, talkingTo: ev.to };
    case "cofounder_history":
      return { ...state, cofounderHistory: "error" in ev ? { error: ev.error } : { exchanges: ev.exchanges } };
    case "new_chat": {
      const idx = stepIndex(state.entries, ev.stepId);
      if (idx === -1) return state;
      const entries = state.entries.slice();
      entries[idx] = { ...entries[idx]!, newChat: true };
      return { ...state, entries };
    }
    case "paused":
      return { ...state, paused: ev.paused, status: ev.paused ? { text: "Paused — hearing, saying and doing nothing", level: "warn" } : { text: "Resumed", level: "ok" } };
    case "viewport":
      return { ...state, viewport: { width: ev.width, height: ev.height } };
    case "screenshot":
      return { ...state, page: { url: ev.url, title: ev.title, frame: `data:image/jpeg;base64,${ev.jpegBase64}`, at: ev.at ?? Date.now(), problem: null } };
    case "frame_status":
      return { ...state, page: { ...state.page, problem: { reason: ev.reason, at: ev.at } } };
    case "status": {
      const status = { text: ev.text, level: ev.level };
      if (ev.level === "busy") return { ...state, status };
      // a non-busy status is the outcome of the latest command; it also ends any confirmation
      const entries = updateLatest(state.entries, (e) => (e.result ? e : { ...e, result: status }));
      return { ...state, status, entries, pending: state.pending?.kind === "confirm" ? null : state.pending };
    }
    case "cofounder_view":
      return { ...state, cofounderView: "error" in ev ? { error: ev.error } : { wsUrl: ev.wsUrl, password: ev.password } };
    case "cofounder_frame":
      return { ...state, cofounderFrame: { jpegBase64: ev.jpegBase64, ...(ev.error ? { error: ev.error } : {}) } };
    case "notice": {
      const entry: LogEntry = { id: nextId++, said: ev.from, decision: null, result: { text: ev.text, level: ev.level } };
      return { ...state, entries: [entry, ...state.entries].slice(0, MAX_ENTRIES) }; // news: at the top, like every other entry
    }
    case "transcript_ack": {
      const entry: LogEntry = { id: nextId++, stepId: ev.stepId, said: ev.text, decision: null, result: null, ...(ev.step ? { step: ev.step } : {}) };
      return { ...state, entries: [entry, ...state.entries].slice(0, MAX_ENTRIES), pending: state.pending?.kind === "clarify" ? null : state.pending };
    }
    case "decision":
      return { ...state, entries: updateLatest(state.entries, (e) => ({ ...e, decision: ev.decision })) };
    case "verify": {
      // background checks can land after later commands, so match on the step id
      const idx = stepIndex(state.entries, ev.stepId);
      if (idx === -1) return state;
      const entries = state.entries.slice();
      entries[idx] = { ...entries[idx]!, verify: ev.verify };
      return { ...state, entries };
    }
    case "confirm":
      return { ...state, pending: { kind: "confirm", actionLabel: ev.actionLabel, reason: ev.reason }, status: { text: "Waiting for confirmation…", level: "warn" } };
    case "clarify":
      return { ...state, pending: { kind: "clarify", question: ev.question, options: ev.options }, status: { text: 'Say "the first one" or click an option', level: "warn" } };
    case "brain_event": {
      const next = applyBrainEvent(state, ev.stepId, ev.runId, ev.event);
      // a new run forgets the last run's manual pick
      let pane = ev.runId !== state.pane.runId ? { ...state.pane, manual: false, runId: ev.runId } : state.pane;
      let jevChrome = state.jevChrome;
      if (ev.event.kind === "tool_start" && ev.event.tool === "chrome") {
        const where = chromeWhere(ev.event.preview);
        if (where.background) jevChrome = { action: where.action, url: where.url ?? jevChrome?.url ?? null, at: Date.now() };
      }
      if (ev.event.kind === "completed" || ev.event.kind === "failed" || ev.event.kind === "cancelled") jevChrome = null;
      if (ev.event.kind === "tool_start" && !pane.manual) {
        const want = paneForTool(ev.event.tool, ev.event.preview);
        if (want && (want === "screen" || (want === "browser" && state.browserView) || (want === "cofounder" && state.cofounder && "computer" in state.cofounder))) pane = { ...pane, tab: want };
      }
      const withChrome = jevChrome === next.jevChrome ? next : { ...next, jevChrome };
      return pane === withChrome.pane ? withChrome : { ...withChrome, pane };
    }
    case "pane_tab":
      return { ...state, pane: { ...state.pane, tab: ev.tab, manual: true } };
    case "dismiss_pending":
      return { ...state, pending: null };
    case "dismiss_approval":
      return { ...state, approval: null };
    case "clear_log":
      return { ...state, entries: [] };
    case "restore_log":
      // after this launch's own entries, never over them
      return { ...state, entries: [...state.entries.filter((e) => !e.past), ...restoredEntries(ev.entries)].slice(0, MAX_ENTRIES) };
    default:
      return state;
  }
}
