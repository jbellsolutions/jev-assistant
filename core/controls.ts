/** The direct lane: the twenty-odd things you say out loud to a Mac that have no path today.
 *
 *  "Turn the volume down", "mute", "next track", "dark mode on", "lock my computer" — Jev has
 *  excellent hands for the browser and none at all for the machine those hands run on. Measured
 *  against the real decider before this file existed, every one of these landed on `hermes` at low
 *  confidence (`lock my computer` 0.26, `turn the volume down` 0.32) — the brain cannot do them, so
 *  they simply failed politely. "previous track" was worse: it routed to `browser_now` and pressed
 *  the browser's BACK button.
 *
 *  Two structural rules this file exists to respect:
 *
 *  1. **No sixth key in ROUTES.** `buildQuestions` passes ROUTES whole into `choice(...)` on every
 *     utterance, so a sixth option redistributes probability across the five and breaks the tuned
 *     0.4/0.6 thresholds in `reconcileRoute`. A control is a `computer`-lane utterance.
 *  2. **No new kind in the `Action` union.** That union drives the decider's output type, three
 *     executor switches and extension/dom-actions.ts. v7 set the precedent with page reading:
 *     extraction is an executor capability, not an Action. Device control is the same shape — it
 *     rides on `Decision.control` and is executed through the existing `Computer` seam.
 *
 *  Pure: no host imports (test/core-boundary.test.ts). */

import { parseDuration, parseReminder } from "./timers.js";

export const CONTROL_TARGETS = ["volume", "media", "display", "system", "timer"] as const;
export type ControlTarget = (typeof CONTROL_TARGETS)[number];

export const VOLUME_ACTIONS = ["up", "down", "mute", "unmute", "set"] as const;
export const MEDIA_ACTIONS = ["play", "pause", "next", "previous"] as const;
export const DISPLAY_ACTIONS = ["dark_on", "dark_off", "toggle"] as const;
export const SYSTEM_ACTIONS = ["lock", "sleep"] as const;
export const TIMER_ACTIONS = ["set", "check", "cancel", "cancel_all"] as const;

export type VolumeAction = (typeof VOLUME_ACTIONS)[number];
export type MediaAction = (typeof MEDIA_ACTIONS)[number];
export type DisplayAction = (typeof DISPLAY_ACTIONS)[number];
export type SystemAction = (typeof SYSTEM_ACTIONS)[number];
export type TimerAction = (typeof TIMER_ACTIONS)[number];

/** Closed on purpose: every level is a line core/lines.ts can pre-render. */
export const LEVELS = ["silent", "quiet", "half", "loud", "max"] as const;
export type Level = (typeof LEVELS)[number];

/** Percentages the levels mean, for the one-shot `set volume output volume N`. */
export const LEVEL_PERCENT: Record<Level, number> = { silent: 0, quiet: 25, half: 50, loud: 75, max: 100 };

/** Apps whose own volume or playback can be targeted separately from the system's. Deliberately
 *  small: each one needs an AppleScript dictionary that actually answers, and hey-jev's
 *  Spotify-only assumption is not a reason to pretend the rest exist. */
export const SCRIPTABLE_PLAYERS = ["spotify", "music"] as const;
export type Player = (typeof SCRIPTABLE_PLAYERS)[number];

/** A discriminated union, so `c.target === "media"` narrows `c.action` to the four media verbs —
 *  the executor switch in server/computer.ts is a compile error away from handling a combination
 *  that cannot exist ("mute the display"). */
export type Control =
  | { target: "volume"; action: VolumeAction; scope?: Player; level?: Level }
  | { target: "media"; action: MediaAction; scope?: Player }
  | { target: "display"; action: DisplayAction }
  | { target: "system"; action: SystemAction }
  // Timers are NOT a Mac capability and deliberately never reach Computer.control — the session
  // owns them, because firing one means speaking, which the Mac lane knows nothing about.
  | { target: "timer"; action: TimerAction; seconds?: number; label?: string | null };

/** Controls that must be SPOKEN BEFORE they run, or Jev talks to a muted speaker or a locked
 *  screen. Straight from hey-jev's SPEAK_FIRST, plus the case its set misses by name: setting the
 *  volume to silent is a mute with a different spelling. */
export function speakFirst(c: Control): boolean {
  if (c.target === "system") return c.action === "lock" || c.action === "sleep";
  if (c.target !== "volume") return false;
  return c.action === "mute" || (c.action === "set" && c.level === "silent");
}

/** Does this utterance plausibly ask the Mac to do something to itself?
 *
 *  A deliberately permissive gate, used for two things: to decide whether to spend the extra
 *  decider questions at all (they are skipped entirely for "click the pricing link", so the
 *  browser fast lane pays nothing for this feature), and to let splitSteps' exemption recognise a
 *  clause it should not fold into its neighbour. False positives are cheap — the model still gets
 *  the final say, and answers `none` — so this errs wide. */
const CONTROL_HINT = new RegExp(
  "\\b(?:" +
    // "turn spotify down" puts the app between the verb and the direction, which a fixed
    // "turn (it|the|this)? up" pattern misses entirely — and that phrase is the headline demo.
    "volume|louder|quieter|turn\\s+(?:\\w+\\s+){0,3}(?:up|down|on|off)|turn (?:down|up)|mute|unmute|sound|audio|" +
    // `resume` is qualified: "open my resume" is a FILE, and an unqualified \bresume\b would
    // spend decider questions on every file open and invite a "play" answer.
    "play|pause|next (?:track|song|one)|previous (?:track|song|one)|skip|last (?:track|song)|" +
    "dark mode|light mode|night mode|appearance|" +
    "lock (?:my |the |this )?(?:computer|mac|screen|laptop)?|log ?out|" +
    "(?:go to |put .{0,20})?sleep|shut ?down|screen ?saver|" +
    "timers?|remind me|reminders?|how (?:much )?long|how many minutes" +
    ")\\b|^resume$|\\bresume (?:the )?(?:music|song|track|playback)\\b",
  "i",
);

/** Phrases that LOOK like a control but are ordinary browser work — the page has a play button,
 *  a volume slider, a "next" link. Checked first so the fast lane keeps them. */
const ON_THE_PAGE = /\b(?:button|link|slider|icon|control|menu|tab|video|player|element|checkbox|toggle switch)\b|\bon (?:the|this) (?:page|screen|site)\b/i;

export function mightBeControl(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (ON_THE_PAGE.test(t)) return false;
  return CONTROL_HINT.test(t);
}

/** The confident subset: a clause that is a control on its own, used where there is no model in
 *  the loop — splitSteps' verb list and the multi-clause exemption in core/session.ts.
 *
 *  Stricter than `mightBeControl` because a false positive here changes how an utterance is CUT,
 *  which no later confidence gate can undo. */
/** The body of a control clause. Shared by two matchers with different anchoring, so the
 *  vocabulary is written once: `controlRequest` (the WHOLE clause is a control) and
 *  `startsWithControl` (a clause BEGINS here, which is how splitSteps decides where to cut). */
const CONTROL_CLAUSE_BODY =
  "(?:" +
  "(?:turn|put)\\s+(?:the\\s+|my\\s+|this\\s+|it\\s+)?(?:volume|sound|audio|music|computer|mac|screen|laptop|brightness|spotify|dark mode|light mode|night mode)?\\s*(?:all the way\\s+)?(?:up|down|on|off|to sleep)|" +
  "turn\\s+(?:on|off)\\s+(?:dark|light|night)\\s*mode|" +
  "(?:mute|unmute|louder|quieter)(?:\\s+(?:it|the\\s+\\w+|spotify|music))?|" +
  "(?:play|pause|resume)(?:\\s+(?:it|the\\s+(?:music|song|track|audio)|music|spotify))?|" +
  "(?:next|previous|last)\\s+(?:track|song|one)|skip(?:\\s+(?:this|that|it|the)?\\s*(?:song|track|one|ahead))?|" +
  "(?:dark|light|night)\\s*mode(?:\\s+(?:on|off))?|" +
  "lock(?:\\s+(?:my|the|this)?\\s*(?:computer|mac|screen|laptop))?|" +
  "(?:go\\s+to\\s+sleep|sleep\\s+the\\s+(?:computer|mac|screen))|" +
  "(?:set|start)\\s+a?\\s*timer\\b.*|remind\\s+me\\b.*|" +
  "(?:cancel|stop|clear)(?:\\s+(?:the|all|my|of|them))*\\s+timers?\\b|" +
  "how\\s+(?:much\\s+)?long\\b.*|how\\s+many\\s+minutes\\b.*" +
  ")";

const CONTROL_CLAUSE = new RegExp(`^${CONTROL_CLAUSE_BODY}\\s*$`, "i");
/** Anchored only at the start: "mute and then lock my computer" begins with a control. */
const CONTROL_CLAUSE_START = new RegExp(`^${CONTROL_CLAUSE_BODY}(?:\\b|$)`, "i");

/** Does this text BEGIN with a device control? Used by splitSteps to decide where to cut an
 *  utterance — without it "open Slack and mute" never splits at all, the whole string decides as
 *  one step, and the mute is silently dropped. Exactly the v4 P0 bug in the other word order. */
export function startsWithControl(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t || ON_THE_PAGE.test(t)) return false;
  return CONTROL_CLAUSE_START.test(t);
}

/** True when this whole clause is a device control and nothing else. */
export function controlRequest(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+$/, "")
    .replace(/\s+please$/, "");
  if (!t || ON_THE_PAGE.test(t)) return false;
  return CONTROL_CLAUSE.test(t);
}

/** Which scriptable player the user named, if any. */
export function playerScope(text: string): Player | undefined {
  const t = text.toLowerCase();
  for (const p of SCRIPTABLE_PLAYERS) if (new RegExp(`\\b${p}\\b`, "i").test(t)) return p;
  // "apple music" and "itunes" are the Music app under other names
  if (/\b(?:apple music|itunes)\b/.test(t)) return "music";
  return undefined;
}

/** "spotify" -> "Spotify", for anything the user reads or hears. */
export function title(name: string): string {
  return name.replace(/^\w/, (ch: string) => ch.toUpperCase());
}

/** What the panel's decision log and the confirm prompt call this. */
export function describeControl(c: Control): string {
  const where = "scope" in c && c.scope ? title(c.scope) : "";
  switch (c.target) {
    case "volume":
      if (c.action === "set") return `Set ${where || "the"} volume to ${c.level ?? "half"}`;
      if (c.action === "mute") return `Mute ${where || "this Mac"}`;
      if (c.action === "unmute") return `Unmute ${where || "this Mac"}`;
      return `Turn ${where || "the volume"} ${c.action}`;
    case "media":
      return { play: `Play${where ? ` in ${where}` : ""}`, pause: "Pause", next: "Next track", previous: "Previous track" }[c.action];
    case "display":
      return { dark_on: "Turn on dark mode", dark_off: "Turn off dark mode", toggle: "Switch appearance" }[c.action];
    case "system":
      return c.action === "lock" ? "Lock the screen" : "Put this Mac to sleep";
    case "timer":
      return { set: "Set a timer", check: "Say how long is left", cancel: "Cancel the timer", cancel_all: "Cancel every timer" }[c.action];
  }
}

/** The scripted reply key for a control (see core/lines.ts). Volume and media get an app-specific
 *  line when the user named one, because "Spotify's a little quieter" is the answer to what they
 *  actually asked, and the generic line would be a lie about the system volume. */
export function lineKey(c: Control): string {
  switch (c.target) {
    case "volume":
      return c.scope ? `app_volume_${c.action}` : `volume_${c.action}`;
    case "media":
      return `media_${c.action}`;
    case "display":
      return `display_${c.action}`;
    case "system":
      return `system_${c.action}`;
    case "timer":
      if (c.action === "set") return c.label ? "reminder_set" : "timer_set";
      if (c.action === "check") return "timer_check";
      return c.action === "cancel_all" ? "timers_cancel" : "timer_cancel";
  }
}

/** Keyword mirror of what Jev answers, for the heuristic decider (no key configured) and for the
 *  hermetic test suite — which runs entirely on HeuristicDecider, so without this the session
 *  wiring tests would exercise the wrong branch and prove nothing. */
export function controlHeuristically(text: string, raw: string = text): Control | undefined {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+$/, "")
    .replace(/\s+please$/, "");
  if (!controlRequest(t)) return undefined;
  const scope = playerScope(t);
  type Scoped = Extract<Control, { scope?: Player }>;
  const withScope = <T extends Scoped>(c: T): T => (scope ? { ...c, scope } : c);

  // Timers first: "remind me in half an hour to lock up" contains "lock" but is a reminder.
  if (/\b(?:cancel|stop|clear)(?:\s+(?:all|my|the|of|them))*\s+timers\b/.test(t)) return { target: "timer", action: "cancel_all" };
  if (/\b(?:cancel|stop|clear)(?:\s+(?:the|my))*\s+timer\b/.test(t)) return { target: "timer", action: "cancel" };
  if (/\bhow\s+(?:much\s+)?long\b|\bhow\s+many\s+minutes\b/.test(t)) return { target: "timer", action: "check" };
  if (/\btimer\b|\bremind\s+me\b/.test(t)) {
    const seconds = parseDuration(t);
    // No duration means this is not a timer we can set — "remind me to call mom at five" is a clock
    // time and belongs to the brain, which knows what five o'clock is.
    if (seconds === null) return undefined;
    // The label is read from `raw`, the utterance as it was actually said. `normalizeSpeech`
    // lower-cases everything on its way in (deliberately — it is matching, not displaying), so the
    // normalized copy reads the label back as "email sarah". This is the same hold-out v7 made for
    // URL paths, and for the same reason: some spans are content, not keys.
    return { target: "timer", action: "set", seconds, label: parseReminder(raw)?.label ?? null };
  }

  if (/\block\b/.test(t)) return { target: "system", action: "lock" };
  if (/\bsleep\b/.test(t)) return { target: "system", action: "sleep" };
  if (/\b(?:dark|night)\s*mode\b/.test(t)) return { target: "display", action: /\boff\b/.test(t) ? "dark_off" : "dark_on" };
  if (/\blight\s*mode\b/.test(t)) return { target: "display", action: "dark_off" };

  if (/\b(?:mute|shh)\b/.test(t) && !/\bunmute\b/.test(t)) return withScope({ target: "volume", action: "mute" });
  if (/\bunmute\b/.test(t)) return withScope({ target: "volume", action: "unmute" });
  if (/\ball the way (?:up|down)\b/.test(t)) return withScope({ target: "volume", action: "set", level: /down\b/.test(t) ? "silent" : "max" });
  if (/\b(?:louder|turn\s+(?:it\s+|the\s+\w+\s+)?up)\b/.test(t)) return withScope({ target: "volume", action: "up" });
  if (/\b(?:quieter|turn\s+(?:it\s+|the\s+\w+\s+|\w+\s+)?down)\b/.test(t)) return withScope({ target: "volume", action: "down" });

  if (/\b(?:next|skip)\b/.test(t)) return withScope({ target: "media", action: "next" });
  if (/\b(?:previous|last)\b/.test(t)) return withScope({ target: "media", action: "previous" });
  if (/\bpause\b/.test(t)) return withScope({ target: "media", action: "pause" });
  if (/\b(?:play|resume)\b/.test(t)) return withScope({ target: "media", action: "play" });
  return undefined;
}

/** The placeholders this control's scripted line needs (see core/lines.ts). Lives here rather than
 *  at the call site so the union's narrowing does, too. */
export function lineVars(c: Control): { app?: string; level?: string } {
  return {
    ...("scope" in c && c.scope ? { app: title(c.scope) } : {}),
    ...(c.target === "volume" && c.level ? { level: c.level } : {}),
  };
}

/** True for the "there was nothing to act on" error (server/computer.ts's NotRunning).
 *
 *  Matched by name rather than by `instanceof`, because core must not import from server/ —
 *  test/core-boundary.test.ts enforces that, and the alternative (moving the class into core) would
 *  put a host concern in the pure layer to satisfy one comparison. */
export function isNotRunning(err: unknown): boolean {
  return err instanceof Error && err.name === "NotRunning";
}
