import type { Action } from "./actions.js";
import type { ApprovalChoice, BrainEvent } from "./brain.js";
import type { Route } from "./route.js";
import type { Blocker } from "./verify.js";

/** WebSocket messages, browser UI -> server. */
export type ClientMessage =
  | { type: "command"; text: string; attachments?: Array<{ id: string; name: string }> }
  | { type: "confirm_reply"; ok: boolean }
  | { type: "pick"; elementId: string }
  /** Answer to a brain approval request (the agent asked before doing something). */
  | { type: "approval_reply"; choice: ApprovalChoice }
  /** Cancel the brain's run AND stop the voice (the Stop button). */
  | { type: "interrupt" }
  /** Just stop talking. The work carries on and the conversation is kept, so pressing the microphone
   *  to add to a request does not cancel the request. */
  | { type: "hush" }
  /** Switch the assistant off (stops everything, refuses commands until resumed) or back on. */
  | { type: "pause"; paused: boolean }
  /** Click on the live view; fx/fy are fractions (0–1) of the image so resizes stay accurate. */
  | { type: "click_at"; fx: number; fy: number }
  /** the user typing into the live view: text at the caret, or one named key ("Enter", "Backspace",
   *  "cmd+a"). Lands on the window the picture shows. */
  | { type: "type_at"; text: string }
  | { type: "key_at"; key: string }
  /** The pixel size the UI has available for the live view; the server sizes the viewport to match. */
  | { type: "viewport"; width: number; height: number }
  | { type: "screenshot_request" }
  /** Whether this panel is showing "Your screen" right now (window visible, that tab open). Windows
   *  are only captured while some panel is — a hidden panel costs nothing. A panel that never says
   *  is treated as watching. */
  | { type: "frames"; on: boolean }
  /** How Jev should listen from now on. Remembered server-side, so it survives a relaunch. */
  | { type: "listen_mode"; mode: SttMode }
  /** Open the co-founder's live desktop (answered with `cofounder_view`), or ask for a still. */
  | { type: "cofounder_view" }
  | { type: "cofounder_frame" }
  /** Mute or unmute Jev's voice. Remembered server-side, like the listen mode. */
  | { type: "voice_mute"; muted: boolean }
  /** Who the user is talking to from now on (the top bar's switch). Remembered server-side. */
  | { type: "talk_to"; to: TalkTo }
  /** the user writing to the co-founder from its tab's chat box, whatever the mode. */
  | { type: "cofounder_say"; text: string }
  /** The co-founder tab's chat, refreshed while that tab is open (answered with `cofounder_history`). */
  | { type: "cofounder_history" };

/** Who the user's words go to: Jev (the default), or straight to the co-founder on Orgo. */
export type TalkTo = "jev" | "cofounder";

/** One exchange in the co-founder's Studio, as its tab's chat shows it. */
export interface CofounderExchange {
  id: string;
  sender: string;
  recipient: string;
  state: string;
  body: string;
  result: string;
  /** Seconds since the epoch, as the Studio stores it. */
  created: number;
}

export interface DecisionSummary {
  command: string;
  intent: string;
  intentConfidence: number;
  route?: Route;
  routeConfidence?: number;
  action: Action;
  actionLabel: string;
  source: "jev" | "heuristic";
  model?: string;
  latencyMs: number;
  inputTokens?: number;
  targetConfidence?: number;
  alternatives?: Array<{ elementId: string; label: string; probability: number }>;
  risky?: number;
}

/** Whether Jev has a voice, which, and where it comes out. `device` is the Mac's default output
 *  (Jev's voice follows it); null when it could not be read. */
export interface VoiceInfo {
  on: boolean;
  detail: string;
  device?: string | null;
  /** the user muted her: nothing is spoken, everything still shows. */
  muted?: boolean;
}

/** WebSocket messages, server -> browser UI. */
/** The connected Chrome extension's protocol against the one this Jev speaks. An older one was
 *  silently loaded from a stale folder for days; this is how the panel says so. */
export type BridgeInfo = { protocol: number; current: number } | null;

export type ServerMessage =
  | {
      type: "hello";
      jev: { enabled: boolean; model: string | null };
      viewport: { width: number; height: number };
      paused?: boolean;
      listen?: ListenSettings;
      /** Whether Jev has a voice at all, and which. Carried to the panel because "no audio" and
       *  "no API key" were indistinguishable: the only place that said so was stdout, which a
       *  Dock-launched app does not have. */
      voice?: VoiceInfo;
      /** The live, clickable view of Jev's own browser (browser-box's player), or null without one. */
      browserView?: string | null;
      /** The co-founder's Orgo computer, when Jev can reach it; null names why not. */
      cofounder?: { computer: string } | { off: string };
      /** Which Chrome extension is connected (null: none). */
      bridge?: BridgeInfo;
      /** Who the user's words go to right now. */
      talkingTo?: TalkTo;
    }
  /** the user switched who he's talking to (by voice, typing, or the top bar). */
  | { type: "talking_to"; to: TalkTo }
  /** The co-founder tab's chat: the latest exchanges, newest first, or why they couldn't be read. */
  | { type: "cofounder_history"; exchanges: CofounderExchange[] }
  | { type: "cofounder_history"; error: string }
  /** The Chrome extension connected, dropped, or said which version it is. */
  | { type: "bridge"; bridge: BridgeInfo }
  /** the user started a new chat ("new chat", or the panel's button): the transcript marks where. */
  | { type: "new_chat"; stepId: number }
  /** Jev is switched off (or back on): nothing is heard, said or done while paused — every UI
   *  and every API caller sees the same switch. */
  | { type: "paused"; paused: boolean }
  /** Audio is playing. Removed in v4 with the rest of the voice layer; back because the panel has
   *  to show it and Escape has to be able to cut it off. */
  | { type: "speaking"; active: boolean }
  /** Answer to `cofounder_view`, to that one socket only: how to open the live desktop. */
  | { type: "cofounder_view"; wsUrl: string; password: string }
  | { type: "cofounder_view"; error: string }
  /** Answer to `cofounder_frame`: a still picture, when the live desktop can't connect. */
  | { type: "cofounder_frame"; jpegBase64: string | null; error?: string }
  /** Something that arrived on its own, not as the answer to a command — the co-founder's reply to
   *  a task handed off earlier. Its own log entry, so it never lands on an unrelated command. */
  | { type: "notice"; from: string; text: string; level: "ok" | "warn" }
  /** The voice changed — in practice, the Mac's output device did (headset unplugged, output
   *  switched in Sound settings). Same shape as hello's. */
  | { type: "voice"; voice: VoiceInfo }
  /** Every running timer, sent whenever the set changes. `dueAt` is absolute epoch ms so the panel
   *  counts down on its own — the server never ticks, which is what keeps this free. */
  | { type: "timers"; timers: Array<{ id: number; dueAt: number; label: string | null }> }
  | { type: "screenshot"; jpegBase64: string; url: string; title: string; at?: number }
  /** "Your screen" has no fresh picture, and why — the panel shows it as not live. */
  | { type: "frame_status"; ok: false; reason: string; at: number }
  | { type: "viewport"; width: number; height: number }
  | { type: "status"; text: string; level: "info" | "busy" | "ok" | "warn" | "error" }
  | { type: "decision"; decision: DecisionSummary }
  | { type: "confirm"; actionLabel: string; reason: string }
  /** Progress of the brain run started by the step acknowledged with `stepId`; an `approval`
   *  event leaves the session waiting for approval_reply (or a spoken yes/no). */
  | { type: "brain_event"; stepId: number; runId: string; event: BrainEvent }
  | { type: "clarify"; question: string; options: Array<{ elementId: string; label: string; probability: number }> }
  /** One per step; `stepId` identifies it for later messages (verify). `step` is present only
   *  when the utterance was split into several. */
  | { type: "transcript_ack"; text: string; stepId: number; step?: StepInfo }
  /** Announces how an utterance was split, before the first step's ack. */
  | { type: "steps"; original: string; commands: string[] }
  /** Outcome check for the step acknowledged with `stepId`. */
  | { type: "verify"; stepId: number; command: string; verify: VerifySummary };

/** Messages on the /ws/stt socket, UI -> server. Audio travels as binary frames between
 *  `start` and `stop`: little-endian 16-bit PCM at `sampleRate`, mono. */
export type SttMode = "push" | "wake";

/** What the panel needs to draw the listening switch: the remembered choice, and whether wake mode
 *  is possible at all (it needs the free on-device recogniser, which a non-Mac build has not got). */
export interface ListenSettings {
  mode: SttMode;
  wakeAvailable: boolean;
}

/** After `stop`, how long the relay waits for the recogniser's last words before flushing anyway.
 *  Shared so the panel can hold its socket open longer than this — closing first throws the words
 *  away, which is what "I let go of the key and nothing happened" was. */
export const STT_FINISH_TIMEOUT_MS = 3000;

export type SttClientMessage =
  /** `mode` picks the listening style. "push" is the button: the client owns start and stop.
   *  "wake" is always-on: the relay owns the boundary and only speaks up after "Hey Jev". */
  | { type: "start"; sampleRate: number; encoding: "pcm_s16le"; channels: 1; lang?: string; keywords?: string[]; mode?: SttMode }
  | { type: "stop" };

/** Messages on the /ws/stt socket, server -> UI. */
export type SttServerMessage =
  | { type: "ready"; provider: string }
  /** Live text for display; never acted on. */
  | { type: "transcript"; text: string; final: false }
  /** A complete utterance: the UI sends it as a command. */
  | { type: "utterance"; text: string }
  | { type: "error"; message: string }
  /** Wake mode only: a bare "Hey Jev" was heard. The panel answers and shows it is listening. */
  | { type: "wake" }
  | { type: "closed" };

export interface VerifySummary {
  done: boolean;
  stuck: boolean;
  doneProbability: number;
  blocker: Blocker;
  source: "code" | "jev" | "heuristic";
  latencyMs: number;
  /** Human-readable, e.g. "done 84%", "stuck: login wall". */
  text: string;
}

export interface StepInfo {
  index: number;
  total: number;
  original: string;
}
