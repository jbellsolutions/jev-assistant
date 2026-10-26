/** Turns a spoken command + page snapshot into an Action.
 *
 *  Division of labour (see docs.typesafe.ai/concepts/how-to-build-with-system-one):
 *   - code pre-parses anything that must be copied verbatim (URLs, text to type);
 *   - Jev answers the judgment calls in ONE request (speculative fan-out): what the user
 *     intends, which element they mean, whether to submit, whether it's risky;
 *   - code applies confidence gates and assembles the Action.
 *  With no API key the same pipeline runs on keyword heuristics so the app still works. */
import { type ChoiceCriteria, type Questions, type SystemOneResult, TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import type { Action, ScrollDirection } from "./actions.js";
import { describeAction } from "./actions.js";
import { type ParsedCommand, knownSiteUrl, parseCommand, parseYesNo } from "./commands.js";
import { NONE_OPTION, type PageElement, type PageSnapshot, describeElement, elementCriteria } from "./elements.js";
import {
  CONTROL_TARGETS,
  type Control,
  type ControlTarget,
  DISPLAY_ACTIONS,
  LEVELS,
  MEDIA_ACTIONS,
  SYSTEM_ACTIONS,
  TIMER_ACTIONS,
  VOLUME_ACTIONS,
  controlHeuristically,
  describeControl,
  mightBeControl,
  playerScope,
} from "./controls.js";
import { parseDuration, parseReminder } from "./timers.js";
import { FAST_LANE_THRESHOLD, ROUTES, ROUTE_THRESHOLD, type Route, appRequest, fileRequest, reconcileRoute, routeHeuristically } from "./route.js";
import { type VerifyInput, type VerifyResult, buildVerifyQuestions, buildVerifyState, heuristicVerdict, interpretVerifyAnswers, quickVerdict } from "./verify.js";

export const INTENTS = {
  open_url: {
    what: "Go to, open, visit or load a specific website, web address or named site",
    examples: ["open google.com", "go to youtube", "take me to the typesafe website"],
  },
  search_web: {
    what: "Run a web search for a topic; no particular site or on-page element is named",
    examples: ["search for cheap flights to lisbon", "google the weather in paris", "look up who invented the telephone"],
  },
  click: {
    what: "Click, press, tap, select, choose, open or toggle something that is on the current page: a link, button, tab, menu item, checkbox",
    examples: ["click on the pricing link", "press the sign in button", "open the first result", "select the docs tab"],
  },
  type_text: {
    what: "Type, enter, write or fill some words into a text field, search box or editor on the current page",
    examples: ["type hello world in the search box", "enter my name john", "search for cats here", "write a comment saying thanks"],
  },
  press_enter: {
    what: "Press the enter/return key or submit the current form without typing anything new",
    examples: ["press enter", "hit return", "submit"],
  },
  scroll: {
    what: "Scroll or move the page up, down, to the top or to the bottom",
    examples: ["scroll down", "go up a bit", "scroll to the bottom", "page down"],
  },
  go_back: { what: "Go back to the previous page in history", examples: ["go back", "back", "previous page"] },
  go_forward: { what: "Go forward in history", examples: ["go forward", "forward"] },
  reload: { what: "Reload or refresh the current page", examples: ["refresh", "reload the page"] },
  stop: { what: "Stop, cancel, wait, or never mind the current action", examples: ["stop", "cancel that", "never mind"] },
  unclear: {
    what: "Not an instruction for the web browser: small talk, a question to the assistant, background speech, or unintelligible",
    examples: ["what do you think", "hello there", "um so anyway"],
  },
} as const;

export type Intent = keyof typeof INTENTS;
/** Browser intents plus the one computer-lane intent code can act on before M5. */
export type DecisionIntent = Intent | "open_app" | "open_path";

export interface Alternative {
  elementId: string;
  label: string;
  probability: number;
}

export interface Decision {
  command: string;
  action: Action;
  intent: DecisionIntent;
  intentConfidence: number;
  /** Which lane handles the utterance; decided on the whole utterance, before splitting. */
  route: Route;
  routeConfidence: number;
  source: "jev" | "heuristic";
  /** P(action is hard to undo) from Jev; heuristics use a keyword list. */
  riskProbability: number;
  needsConfirmation: boolean;
  targetConfidence: number | null;
  alternatives: Alternative[];
  clarify: { question: string; options: Alternative[] } | null;
  /** The direct lane: a device control on this Mac (volume, media, appearance, power). Rides here
   *  rather than in `Action` on purpose — see the header of core/controls.ts. Only ever set when
   *  `route === "computer"`, and checked before the open_app/open_path branches in core/session.ts. */
  control?: Control;
  meta: { model?: string; latencyMs: number; inputTokens?: number; fallbackReason?: string };
}

export const THRESHOLDS = {
  /** Below this, an intent answer is treated as "unclear" rather than acted on. */
  intent: 0.25,
  /** Below this, a target pick becomes a clarification with the top alternatives. */
  target: 0.35,
  /** Below this, a suspected device control is left to the ordinary lanes. Set high on purpose:
   *  these actions are immediate and physical (muting, locking, sleeping), the gate that reaches
   *  them is a permissive regex, and a wrong one is far more annoying than a missed one. */
  control: 0.6,
  /** Noul probability above which an action needs a spoken/clicked confirmation. */
  risk: 0.6,
  /** Noul probability above which typed text is followed by Enter. */
  submit: 0.6,
  /** Below this the route answer is ignored and the brain takes the utterance. */
  route: ROUTE_THRESHOLD,
  /** Route confidence the fast lanes (browser_now, computer) need; less is conversation. */
  fastLane: FAST_LANE_THRESHOLD,
  /** Intent confidence at or above which a browser intent counts as actionable for the fast lane. */
  browserIntent: 0.6,
};

/** Actions that are gated by the risk check; navigation and scrolling never are. */
const GATED_KINDS = new Set<Action["kind"]>(["click", "type", "press"]);

export function buildState(parsed: ParsedCommand, snapshot: PageSnapshot) {
  return {
    command: parsed.text,
    page: { url: snapshot.url, title: snapshot.title },
  };
}

/** Every question in one request; code reads only the answers the intent needs. */
export function buildQuestions(parsed: ParsedCommand, snapshot: PageSnapshot): Questions {
  const questions: Questions = {
    route: choice(
      {
        question: "The user is talking to their assistant, who answers and remembers. Should this go to the assistant as conversation, or is it an obvious quick action for the browser on the current page, or for opening a Mac app?",
        command: parsed.text,
      },
      ROUTES as unknown as ChoiceCriteria,
    ),
    intent: choice(
      { question: "If this is for the web browser, what is the user asking it to do?", command: parsed.text },
      INTENTS as unknown as ChoiceCriteria,
    ),
    risky: noul(
      { question: "Would carrying out this command do something hard to undo?", command: parsed.text },
      {
        true: "It would buy or pay for something, delete or remove data, send a message or email, post publicly, log out, or confirm/submit an order",
        false: "It only reads, navigates, scrolls, searches, types into a field, or opens something",
      },
    ),
    scroll_direction: choice({ question: "Which way does the user want the page to move?", command: parsed.text }, {
      down: "further down the page",
      up: "back up the page",
      top: "all the way to the top / beginning",
      bottom: "all the way to the bottom / end",
    }),
    submit_after_typing: noul(
      { question: "After the text is typed, does the user want it submitted right away (press enter / run the search)?", command: parsed.text },
      { true: "Yes: they said to search, submit, press enter, or the phrasing is 'search for X'", false: "No: just fill in the text and wait" },
    ),
  };
  // Only asked when the utterance could plausibly be a device control. The browser fast lane —
  // "click the pricing link", "scroll down" — pays nothing for this feature, which matters because
  // every question here rides along on EVERY utterance that does ask them. Same conditional shape
  // as `target` and `url_pick` below.
  if (mightBeControl(parsed.text)) {
    questions.control_target = choice(
      // Wording matters more here than anywhere else in this file, and it was measured rather
      // than guessed. The first draft described `none` as "anything else, including clicking a
      // play button on the page" — with a page in the state, that pulled terse commands to
      // `none` even when the follow-up answer was certain: "turn on dark mode" came back
      // none 0.79 / display 0.21 while display_action said dark_on at 1.00. Page elements are
      // already excluded before this question is asked (ON_THE_PAGE in core/controls.ts), so
      // naming them here only muddies it. Each option now names the terse phrasings people
      // actually say out loud, because those one-word commands are the ambiguous ones.
      { question: "The user said this out loud to their Mac. Are they telling the MACHINE ITSELF to do something to its own volume, playback, appearance, or power — as opposed to asking a question, giving a task, or acting on a web page?", command: parsed.text },
      {
        volume: "How loud the Mac or an app on it is. Said as: 'mute', 'unmute', 'louder', 'quieter', 'turn it up', 'turn the volume down', 'turn Spotify down', 'all the way up'",
        media: "Whatever is playing right now. Said as: 'play', 'pause', 'resume', 'next track', 'skip this song', 'previous track'",
        display: "How the Mac looks. Said as: 'dark mode', 'turn on dark mode', 'dark mode off', 'light mode', 'night mode'",
        system: "The Mac's screen or power. Said as: 'lock', 'lock my computer', 'go to sleep', 'put the computer to sleep'",
        timer: "A timer or a reminder for a length of time from now. Said as: 'set a timer for ten minutes', 'remind me in 20 minutes to call Bob', 'how long is left?', 'cancel the timer'",
        none: "None of those — a question, a message, a reminder, a to-do, research, or an instruction about a web page or an app's contents rather than the machine's own settings",
      },
    );
    questions.volume_action = choice({ question: "If this is about volume, what should happen to it?", command: parsed.text }, {
      up: "louder, turn it up",
      down: "quieter, turn it down",
      mute: "silence it completely, mute",
      unmute: "bring the sound back, unmute",
      set: "set it to a particular level they named (all the way up, halfway, as quiet as possible)",
    });
    questions.volume_level = choice({ question: "If they named a volume level, which one?", command: parsed.text }, {
      silent: "all the way down, off, silent",
      quiet: "low, a bit quiet",
      half: "halfway, medium",
      loud: "high, loud",
      max: "all the way up, maximum",
    });
    questions.media_action = choice({ question: "If this is about what is playing, what should happen?", command: parsed.text }, {
      play: "start or resume playing",
      pause: "pause or stop playing",
      next: "skip forward to the next track",
      previous: "go back to the previous track",
    });
    questions.display_action = choice({ question: "If this is about the Mac's appearance, what do they want?", command: parsed.text }, {
      dark_on: "turn dark mode on",
      dark_off: "turn dark mode off, go back to light",
      toggle: "switch it, whichever way it is now",
    });
    questions.system_action = choice({ question: "If this is about the Mac's power or screen, what do they want?", command: parsed.text }, {
      lock: "lock the screen, so a password is needed",
      sleep: "put the whole Mac to sleep",
    });
    questions.timer_action = choice({ question: "If this is about a timer or reminder, what do they want?", command: parsed.text }, {
      set: "start a new timer or reminder",
      check: "ask how much time is left on one",
      cancel: "cancel the timer that is running",
      cancel_all: "cancel every timer at once",
    });
  }
  if (snapshot.elements.length > 0) {
    questions.target = choice(
      {
        question: "Which element on the current page is the user referring to? Choose 'none' if the command does not name anything on this page.",
        command: parsed.text,
      },
      elementCriteria(snapshot.elements),
    );
  }
  if (parsed.urls.length > 1) {
    questions.url_pick = choice(
      { question: "Which of these web addresses does the user want to open?", command: parsed.text },
      Object.fromEntries(parsed.urls.map((u) => [u, null])),
    );
  }
  return questions;
}

type Answers = SystemOneResult<Questions>["answers"];

function choiceOf(answers: Answers, key: string): { choice: string; confidence: number; probabilities: Record<string, number> } | null {
  const a = answers[key];
  if (!a || a.type !== "choice") return null;
  return { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities as Record<string, number> };
}

function noulOf(answers: Answers, key: string, fallback = 0): number {
  const a = answers[key];
  return a && a.type === "noul" ? a.noul : fallback;
}

export function searchUrl(query: string): string {
  return `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
}

function topAlternatives(probabilities: Record<string, number>, elements: PageElement[], limit = 3): Alternative[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  return Object.entries(probabilities)
    .filter(([id, p]) => id !== NONE_OPTION && p >= 0.05 && byId.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, p]) => ({ elementId: id, label: describeElement(byId.get(id)!), probability: p }));
}

function textAfterVerb(parsed: ParsedCommand): string {
  return parsed.text.replace(/^(?:type|enter|write|input|put|say|search for|search|look up|google|find)\s+/, "").trim();
}

function base(parsed: ParsedCommand, intent: DecisionIntent, intentConfidence: number, source: Decision["source"], action: Action): Decision {
  return {
    command: parsed.text,
    action,
    intent,
    intentConfidence,
    route: "browser_now",
    routeConfidence: 0,
    source,
    riskProbability: 0,
    needsConfirmation: false,
    targetConfidence: null,
    alternatives: [],
    clarify: null,
    meta: { latencyMs: 0 },
  };
}

/** How sure Jev is that this is a device control at all. */
function controlConfidence(answers: Answers): number {
  return choiceOf(answers, "control_target")?.confidence ?? 0;
}

/** Jev's answers -> a device control, or undefined.
 *
 *  The gate is deliberately on `control_target` alone. The per-target questions ("if this is about
 *  volume…") are answered for every gated utterance whether or not they apply, so their own
 *  confidence means little — what matters is whether this is a control, and of what kind. */
export function interpretControl(answers: Answers, parsed: ParsedCommand): Control | undefined {
  const target = choiceOf(answers, "control_target");
  if (!target || target.choice === NONE_OPTION || target.choice === "none") return undefined;
  if (!CONTROL_TARGETS.includes(target.choice as ControlTarget)) return undefined;
  if (target.confidence < THRESHOLDS.control) return undefined;

  const pick = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const a = choiceOf(answers, key);
    return a && (allowed as readonly string[]).includes(a.choice) ? (a.choice as T) : undefined;
  };
  const scope = playerScope(parsed.text);

  switch (target.choice as ControlTarget) {
    case "volume": {
      const action = pick("volume_action", VOLUME_ACTIONS);
      if (!action) return undefined;
      const level = action === "set" ? pick("volume_level", LEVELS) ?? "half" : undefined;
      return { target: "volume", action, ...(scope ? { scope } : {}), ...(level ? { level } : {}) };
    }
    case "media": {
      const action = pick("media_action", MEDIA_ACTIONS);
      return action ? { target: "media", action, ...(scope ? { scope } : {}) } : undefined;
    }
    case "display": {
      const action = pick("display_action", DISPLAY_ACTIONS);
      return action ? { target: "display", action } : undefined;
    }
    case "system": {
      const action = pick("system_action", SYSTEM_ACTIONS);
      return action ? { target: "system", action } : undefined;
    }
    case "timer": {
      const action = pick("timer_action", TIMER_ACTIONS);
      if (!action) return undefined;
      if (action !== "set") return { target: "timer", action };
      // A timer needs a LENGTH. "Remind me to call mom at five" is a clock time, which this lane
      // cannot represent — handing it here would answer "how long for?" to a perfectly clear
      // request, so it falls through to the brain, which knows what five o'clock is.
      const seconds = parseDuration(parsed.text);
      if (seconds === null) return undefined;
      // `raw`, not `text`: the label is read back out loud and shown in the panel, and
      // normalizeSpeech lower-cases `text`. See the note in controlHeuristically.
      return { target: "timer", action: "set", seconds, label: parseReminder(parsed.raw)?.label ?? null };
    }
  }
}

/** Pure: Jev's answers + pre-parsed command -> Decision. */
export function interpretAnswers(answers: Answers, parsed: ParsedCommand, snapshot: PageSnapshot): Decision {
  const d = interpretBrowserAnswers(answers, parsed, snapshot);
  const actionable = d.intent !== "unclear" && d.intent !== "stop";
  const control = interpretControl(answers, parsed);
  // A confidently-answered control claims the computer lane. Without this, every one of these
  // utterances routes to `hermes` (measured: "lock my computer" 0.26, "turn the volume down" 0.32)
  // or, worse, to `browser_now` — "previous track" pressed the browser's BACK button.
  const r = control ? { route: "computer" as Route, confidence: controlConfidence(answers) } : reconcileRoute(choiceOf(answers, "route"), actionable && d.intentConfidence >= THRESHOLDS.browserIntent, actionable);
  return applyRoute(d, r.route, r.confidence, parsed, control);
}

/** Stamp the lane onto a browser decision and swap in the lane's own action where code can
 *  act: a parsed app name for the computer lane, a stop for stop. A computer route without a
 *  recognisable app, and background speech, are handed to the brain / reported as unclear. */
function applyRoute(d: Decision, route: Route, confidence: number, parsed: ParsedCommand, control?: Control): Decision {
  d.route = route;
  d.routeConfidence = confidence;
  if (route === "computer") {
    // A control wins over app/file: "turn Spotify down" names an app but is not a request to open
    // it, and appRequest would not match it anyway — this ordering is what stops it falling
    // through to the hermes downgrade below, which is where every one of these landed before.
    if (control) {
      d.control = control;
      d.intent = "unclear";
      d.action = { kind: "none", reason: describeControl(control) };
      d.needsConfirmation = false;
      d.clarify = null;
      return d;
    }
    const app = appRequest(parsed.text);
    const file = app ? null : fileRequest(parsed.text);
    if (app) {
      d.intent = "open_app";
      d.action = { kind: "open_app", app };
      d.needsConfirmation = false;
      d.clarify = null;
    } else if (file) {
      d.intent = "open_path";
      d.action = { kind: "open_path", query: file };
      d.needsConfirmation = false;
      d.clarify = null;
    } else {
      d.route = "hermes";
      d.meta.fallbackReason ??= `computer route but no app/file matched in "${parsed.text}"`;
    }
  } else if (route === "stop") {
    d.intent = "stop";
    d.action = { kind: "stop" };
    d.needsConfirmation = false;
    d.clarify = null;
  } else if (route === "unclear") {
    d.intent = "unclear";
    d.action = { kind: "none", reason: "That didn't sound like it was for me" };
    d.needsConfirmation = false;
    d.clarify = null;
  }
  return d;
}

/** Pure: the browser part of Jev's answers -> Decision (route still to be applied). */
function interpretBrowserAnswers(answers: Answers, parsed: ParsedCommand, snapshot: PageSnapshot): Decision {
  const intentAns = choiceOf(answers, "intent");
  let intent = (intentAns?.choice ?? "unclear") as Intent;
  const intentConfidence = intentAns?.confidence ?? 0;
  if (!(intent in INTENTS) || intentConfidence < THRESHOLDS.intent) intent = "unclear";

  const target = choiceOf(answers, "target");
  const alternatives = target ? topAlternatives(target.probabilities, snapshot.elements) : [];
  const pickedElement = target && target.choice !== NONE_OPTION ? snapshot.elements.find((e) => e.id === target.choice) ?? null : null;
  const targetConfident = !!target && target.confidence >= THRESHOLDS.target;

  const finish = (action: Action): Decision => {
    const d = base(parsed, intent, intentConfidence, "jev", action);
    d.riskProbability = noulOf(answers, "risky");
    d.needsConfirmation = GATED_KINDS.has(action.kind) && d.riskProbability >= THRESHOLDS.risk;
    d.targetConfidence = target?.confidence ?? null;
    d.alternatives = alternatives;
    return d;
  };

  switch (intent) {
    case "open_url": {
      const picked = choiceOf(answers, "url_pick")?.choice;
      const url = (picked && parsed.urls.includes(picked) ? picked : parsed.urls[0]) ?? parsed.siteGuess;
      if (url) return finish({ kind: "navigate", url });
      const q = parsed.navTarget ?? parsed.searchQuery ?? textAfterVerb(parsed);
      return finish({ kind: "search", query: q, url: searchUrl(q) });
    }
    case "search_web": {
      const q = parsed.searchQuery ?? parsed.navTarget ?? textAfterVerb(parsed);
      return finish({ kind: "search", query: q, url: searchUrl(q) });
    }
    case "click": {
      if (pickedElement && targetConfident) {
        return finish({ kind: "click", elementId: pickedElement.id, label: describeElement(pickedElement) });
      }
      const d = finish({ kind: "none", reason: `I couldn't find "${parsed.clickLabel ?? parsed.text}" on this page` });
      if (alternatives.length > 0) {
        d.clarify = { question: `Which one did you mean${parsed.clickLabel ? ` by "${parsed.clickLabel}"` : ""}?`, options: alternatives };
      }
      return d;
    }
    case "type_text": {
      const text = parsed.typed?.text ?? textAfterVerb(parsed);
      if (!text) return finish({ kind: "none", reason: "I didn't catch what to type" });
      const submit = parsed.typed?.submit || noulOf(answers, "submit_after_typing") >= THRESHOLDS.submit;
      const el = pickedElement && targetConfident ? pickedElement : null;
      return finish({ kind: "type", elementId: el?.id ?? null, label: el ? describeElement(el) : null, text, submit });
    }
    case "press_enter":
      return finish({ kind: "press", key: "Enter" });
    case "scroll": {
      const dir = (parsed.scroll ?? (choiceOf(answers, "scroll_direction")?.choice as ScrollDirection | undefined) ?? "down") as ScrollDirection;
      return finish({ kind: "scroll", direction: dir });
    }
    case "go_back":
      return finish({ kind: "back" });
    case "go_forward":
      return finish({ kind: "forward" });
    case "reload":
      return finish({ kind: "reload" });
    case "stop":
      return finish({ kind: "stop" });
    case "unclear":
    default:
      return finish({ kind: "none", reason: "That didn't sound like a browser command" });
  }
}

// ---------------------------------------------------------------------------
// Heuristic fallback (no API key, or Jev unreachable)
// ---------------------------------------------------------------------------

export const RISKY_WORDS = /\b(?:buy|purchase|pay|checkout|order|delete|remove|send|post|publish|submit|confirm|log ?out|sign ?out|unsubscribe|transfer)\b/;

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9@.]+/).filter((t) => t.length > 1 && !["the", "on", "in", "to", "of", "and", "a", "an"].includes(t));
}

/** Score page elements against a spoken label: token overlap plus substring bonus. */
export function matchElements(label: string, elements: PageElement[], fieldsOnly = false): Alternative[] {
  const want = tokens(label);
  if (want.length === 0) return [];
  const scored: Alternative[] = [];
  for (const e of elements) {
    const isField = ["input", "textarea", "select"].includes(e.tag) || ["textbox", "combobox", "searchbox"].includes(e.role);
    if (fieldsOnly && !isField) continue;
    const hay = `${e.text} ${e.label} ${e.placeholder} ${e.name} ${e.hrefShort ?? ""} ${describeElement(e)}`.toLowerCase();
    const have = new Set(tokens(hay));
    let hits = 0;
    for (const w of want) if (have.has(w) || hay.includes(w)) hits++;
    if (hits === 0) continue;
    let score = hits / want.length;
    if (hay.includes(label.toLowerCase())) score += 0.5;
    if (e.inViewport) score += 0.05;
    scored.push({ elementId: e.id, label: describeElement(e), probability: score });
  }
  scored.sort((a, b) => b.probability - a.probability);
  const total = scored.reduce((s, a) => s + a.probability, 0) || 1;
  return scored.slice(0, 3).map((a) => ({ ...a, probability: Math.min(1, a.probability / total) }));
}

export function decideHeuristically(parsed: ParsedCommand, snapshot: PageSnapshot): Decision {
  const d = decideBrowserHeuristically(parsed, snapshot);
  // Mirrors interpretControl's precedence: a control claims the computer lane outright.
  const control = controlHeuristically(parsed.text, parsed.raw);
  if (control) return applyRoute(d, "computer", 0.85, parsed, control);
  const r = routeHeuristically(parsed.text, d.intent !== "unclear" && d.intent !== "stop");
  // "open the documentation" with a Documentation link in front is that link, not a file search
  if (r.route === "computer" && !appRequest(parsed.text) && d.action.kind === "click") return applyRoute(d, "browser_now", r.confidence, parsed);
  return applyRoute(d, r.route, r.confidence, parsed);
}

function decideBrowserHeuristically(parsed: ParsedCommand, snapshot: PageSnapshot): Decision {
  const t = parsed.text;
  const mk = (intent: Intent, action: Action, conf = 0.7): Decision => {
    const d = base(parsed, intent, conf, "heuristic", action);
    d.riskProbability = RISKY_WORDS.test(t) ? 0.8 : 0.05;
    d.needsConfirmation = GATED_KINDS.has(action.kind) && d.riskProbability >= THRESHOLDS.risk;
    return d;
  };
  const fields = snapshot.elements.filter((e) => ["input", "textarea"].includes(e.tag) || ["textbox", "combobox", "searchbox"].includes(e.role));
  const searchBox = fields.find((e) => /search/i.test(`${e.type} ${e.placeholder} ${e.label} ${e.name} ${e.role}`));

  if (/^(?:stop|cancel|halt|wait|never ?mind|abort)(?:\s+(?:that|it|this))?$/.test(t)) return mk("stop", { kind: "stop" }, 0.95);
  if (/^(?:go\s+)?back(?:wards?)?(?:\s+(?:a\s+)?page)?$|^previous page$/.test(t)) return mk("go_back", { kind: "back" }, 0.95);
  if (/^(?:go\s+)?forwards?$/.test(t)) return mk("go_forward", { kind: "forward" }, 0.95);
  if (/^(?:reload|refresh)(?:\s+(?:the\s+)?page)?$/.test(t)) return mk("reload", { kind: "reload" }, 0.95);
  if (/\bscroll\b|^page (?:up|down)$|^(?:go|move) (?:up|down)\b/.test(t)) return mk("scroll", { kind: "scroll", direction: parsed.scroll ?? "down" }, 0.9);
  if (/^(?:press|hit|push)\s+(?:the\s+)?(?:enter|return)(?:\s+key)?$|^submit(?:\s+(?:the\s+)?form)?$/.test(t)) return mk("press_enter", { kind: "press", key: "Enter" }, 0.95);

  if (parsed.typed && /^(?:type|enter|write|input|fill|put|insert|paste|key in)\b/.test(t)) {
    const cands = parsed.typed.targetHint ? matchElements(parsed.typed.targetHint, fields, true) : [];
    const el = cands[0] ? snapshot.elements.find((e) => e.id === cands[0]!.elementId) ?? null : null;
    return mk("type_text", { kind: "type", elementId: el?.id ?? null, label: el ? describeElement(el) : null, text: parsed.typed.text, submit: parsed.typed.submit });
  }
  if (parsed.searchQuery !== null && /^(?:search|google|look ?up|find)\b/.test(t)) {
    if (searchBox && !/\b(?:web|internet|google|online)\b/.test(t)) {
      return mk("type_text", { kind: "type", elementId: searchBox.id, label: describeElement(searchBox), text: parsed.searchQuery, submit: true });
    }
    return mk("search_web", { kind: "search", query: parsed.searchQuery, url: searchUrl(parsed.searchQuery) });
  }
  if (parsed.urls[0]) return mk("open_url", { kind: "navigate", url: parsed.urls[0] }, 0.9);
  if (parsed.navTarget) {
    // "open pricing" on a page that has a Pricing link means click, not navigate
    const onPage = matchElements(parsed.navTarget, snapshot.elements);
    if (onPage[0] && onPage[0].probability >= 0.5 && !knownSiteUrl(parsed.navTarget)) {
      const el = snapshot.elements.find((e) => e.id === onPage[0]!.elementId)!;
      return mk("click", { kind: "click", elementId: el.id, label: describeElement(el) }, 0.6);
    }
    if (parsed.siteGuess) return mk("open_url", { kind: "navigate", url: parsed.siteGuess }, 0.6);
    if (onPage[0]) {
      const el = snapshot.elements.find((e) => e.id === onPage[0]!.elementId)!;
      return mk("click", { kind: "click", elementId: el.id, label: describeElement(el) }, 0.5);
    }
    return mk("search_web", { kind: "search", query: parsed.navTarget, url: searchUrl(parsed.navTarget) }, 0.5);
  }
  if (parsed.clickLabel) {
    const cands = matchElements(parsed.clickLabel, snapshot.elements);
    const d = mk("click", { kind: "none", reason: `I couldn't find "${parsed.clickLabel}" on this page` }, 0.6);
    d.alternatives = cands;
    if (cands[0] && (cands[0].probability >= 0.5 || cands.length === 1)) {
      const el = snapshot.elements.find((e) => e.id === cands[0]!.elementId)!;
      d.action = { kind: "click", elementId: el.id, label: describeElement(el) };
      d.needsConfirmation = GATED_KINDS.has("click") && d.riskProbability >= THRESHOLDS.risk;
      d.targetConfidence = cands[0].probability;
    } else if (cands.length > 1) {
      d.clarify = { question: `Which one did you mean by "${parsed.clickLabel}"?`, options: cands };
    }
    return d;
  }
  return mk("unclear", { kind: "none", reason: "That didn't sound like a browser command" }, 0.3);
}

// ---------------------------------------------------------------------------
// Decider: Jev when configured, heuristics otherwise (and as a safety net)
// ---------------------------------------------------------------------------

export type ReplyKind = "confirm" | "cancel" | "other";

export interface Decider {
  readonly enabled: boolean;
  readonly model: string | null;
  decide(raw: string, snapshot: PageSnapshot, signal?: AbortSignal): Promise<Decision>;
  classifyReply(raw: string, pendingActionLabel: string): Promise<ReplyKind>;
  /** Did the action achieve the step? Code decides the obvious cases; Jev the rest. */
  verify(input: VerifyInput, signal?: AbortSignal): Promise<VerifyResult>;
}

export class HeuristicDecider implements Decider {
  readonly enabled = false;
  readonly model = null;
  async decide(raw: string, snapshot: PageSnapshot): Promise<Decision> {
    const t0 = performance.now();
    const d = decideHeuristically(parseCommand(raw), snapshot);
    d.meta.latencyMs = Math.round(performance.now() - t0);
    return d;
  }
  async classifyReply(raw: string): Promise<ReplyKind> {
    const yn = parseYesNo(raw);
    return yn === null ? "other" : yn ? "confirm" : "cancel";
  }
  async verify(input: VerifyInput): Promise<VerifyResult> {
    const state = buildVerifyState(input);
    return quickVerdict(state, input.action) ?? heuristicVerdict(state);
  }
}

export class JevDecider implements Decider {
  readonly enabled = true;
  readonly model: string;
  private readonly fallback = new HeuristicDecider();

  constructor(private readonly client: TypeSafeClient) {
    this.model = client.defaultModel;
  }

  async decide(raw: string, snapshot: PageSnapshot, signal?: AbortSignal): Promise<Decision> {
    const parsed = parseCommand(raw);
    const t0 = performance.now();
    try {
      const res = await this.client.systemOne({ state: buildState(parsed, snapshot), questions: buildQuestions(parsed, snapshot) }, { signal, timeout: 8000 });
      const d = interpretAnswers(res.answers, parsed, snapshot);
      d.meta = { model: res.model, latencyMs: Math.round(performance.now() - t0), inputTokens: res.usage.input_tokens };
      return d;
    } catch (err) {
      if (signal?.aborted) throw err;
      const d = decideHeuristically(parsed, snapshot);
      d.meta.latencyMs = Math.round(performance.now() - t0);
      d.meta.fallbackReason = err instanceof Error ? err.message : String(err);
      return d;
    }
  }

  async verify(input: VerifyInput, signal?: AbortSignal): Promise<VerifyResult> {
    const state = buildVerifyState(input);
    const quick = quickVerdict(state, input.action);
    if (quick) return quick;
    const t0 = performance.now();
    try {
      const res = await this.client.systemOne({ state, questions: buildVerifyQuestions(state) }, { signal, timeout: 6000 });
      const v = interpretVerifyAnswers(res.answers);
      v.meta = { latencyMs: Math.round(performance.now() - t0), inputTokens: res.usage.input_tokens };
      return v;
    } catch (err) {
      if (signal?.aborted) throw err;
      const v = heuristicVerdict(state);
      v.meta = { latencyMs: Math.round(performance.now() - t0), fallbackReason: err instanceof Error ? err.message : String(err) };
      return v;
    }
  }

  /** Fast regex first; Jev only for replies like "go ahead and do it" the regex misses. */
  async classifyReply(raw: string, pendingActionLabel: string): Promise<ReplyKind> {
    const yn = parseYesNo(raw);
    if (yn !== null) return yn ? "confirm" : "cancel";
    try {
      const res = await this.client.systemOne(
        {
          state: { pending_action: pendingActionLabel, user_reply: raw },
          questions: {
            reply: choice("The browser asked the user to confirm the pending action. How does the user's reply answer that?", {
              confirm: "Agrees: go ahead with the pending action",
              cancel: "Declines: do not do the pending action",
              other: "Neither: it is a new, unrelated command or not an answer",
            }),
          },
        },
        { timeout: 5000 },
      );
      const a = res.answers.reply;
      return a.confidence >= 0.4 ? a.choice : "other";
    } catch {
      return "other";
    }
  }
}

export function createDecider(env: NodeJS.ProcessEnv = process.env): Decider {
  if (!env.TYPESAFE_API_KEY?.trim()) return new HeuristicDecider();
  return new JevDecider(new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY, logLevel: "warn" }));
}

export { describeAction };
