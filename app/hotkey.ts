/** Panel visibility state machine, kept pure so it can be tested without Electron.
 *  One global hotkey shows/focuses the panel; Escape hides it, or cancels busy work first. */

export interface PanelState {
  visible: boolean;
  /** A command or brain run is in flight. */
  busy: boolean;
  /** Switched off: nothing is heard, said or done until resumed. */
  paused?: boolean;
  /** Jev's voice is playing. In wake mode the microphone is deaf while it is, so a keystroke is the
   *  only way to cut her off — which is why this belongs in the panel's state machine. */
  speaking?: boolean;
}

export type PanelEffect = "show" | "hide" | "focus" | "cancel" | "resume" | "hush";

/** ⌥Space always brings the panel to the front; it never hides it (there is nothing to "stop
 *  listening" to any more — that toggle died with on-device STT). */
export function onHotkey(s: PanelState): { state: PanelState; effects: PanelEffect[] } {
  // Talking over her is the one thing ⌥Space must always do first, even from a hidden panel.
  if (s.speaking) {
    const effects: PanelEffect[] = ["hush"];
    if (!s.visible) effects.push("show");
    effects.push("focus");
    return { state: { ...s, visible: true, speaking: false }, effects };
  }
  if (s.paused) {
    const effects: PanelEffect[] = ["resume"];
    if (!s.visible) effects.push("show");
    effects.push("focus");
    return { state: { ...s, visible: true, paused: false }, effects };
  }
  if (!s.visible) return { state: { ...s, visible: true }, effects: ["show", "focus"] };
  return { state: s, effects: ["focus"] };
}

/** Escape: cancel in-flight work if the panel is busy (stays open so the outcome is visible),
 *  else tuck the panel away. */
export function onEscape(s: PanelState): { state: PanelState; effects: PanelEffect[] } {
  // Cut her off, and leave the panel exactly where it was: the first Escape is "be quiet", not
  // "stop what you are doing" and not "go away".
  if (s.speaking) return { state: { ...s, speaking: false }, effects: ["hush"] };
  if (s.busy) return { state: s, effects: ["cancel"] };
  if (s.visible) return { state: { ...s, visible: false }, effects: ["hide"] };
  return { state: s, effects: [] };
}

/** The renderer reports whether a command or brain run is in flight. */
export function onRendererBusy(s: PanelState, busy: boolean): PanelState {
  return s.busy === busy ? s : { ...s, busy };
}

/** The renderer reports whether Jev's voice is playing. */
export function onRendererSpeaking(s: PanelState, speaking: boolean): PanelState {
  return !!s.speaking === speaking ? s : { ...s, speaking };
}

/** The hub's pause switch changed (tray, panel or API). Pausing also cancels whatever was busy. */
export function onPaused(s: PanelState, paused: boolean): PanelState {
  if (!!s.paused === paused) return s;
  return paused ? { ...s, paused: true, busy: false } : { ...s, paused: false };
}

export function onWindowVisibility(s: PanelState, visible: boolean): PanelState {
  return s.visible === visible ? s : { ...s, visible };
}

// ---- the talk key (Fn+Control by default) -----------------------------------------------------

/** Under this, a press is a TAP: hands-free — keep listening until the next tap. Over it, a HOLD:
 *  listen while held, send on release. */
export const TAP_MS = 300;

export interface TalkState {
  /** idle · holding (keys down, listening) · handsfree (tapped, listening) · releasing (the second
   *  tap's keys are still down; its release must not start anything). */
  phase: "idle" | "holding" | "handsfree" | "releasing";
  downAt: number;
}

export const TALK_IDLE: TalkState = { phase: "idle", downAt: 0 };

/** start: open the microphone · stop: close it and send what was said · abort: close it, send
 *  nothing · hush: cut Jev off first (talking over her is the point of pressing the key). */
export type TalkEffect = "hush" | "start" | "stop" | "abort";

export function onTalkKey(s: TalkState, event: "down" | "up" | "cancel", now: number, speaking = false): { state: TalkState; effects: TalkEffect[] } {
  switch (s.phase) {
    case "idle":
      if (event !== "down") return { state: s, effects: [] };
      return { state: { phase: "holding", downAt: now }, effects: speaking ? ["hush", "start"] : ["start"] };
    case "holding":
      if (event === "cancel") return { state: TALK_IDLE, effects: ["abort"] }; // it was a shortcut, not talk
      if (event === "up") return now - s.downAt < TAP_MS ? { state: { ...s, phase: "handsfree" }, effects: [] } : { state: TALK_IDLE, effects: ["stop"] };
      return { state: s, effects: [] };
    case "handsfree":
      if (event === "down") return { state: { phase: "releasing", downAt: now }, effects: ["stop"] };
      return { state: s, effects: [] };
    case "releasing":
      if (event === "up" || event === "cancel") return { state: TALK_IDLE, effects: [] };
      return { state: s, effects: [] };
  }
}
