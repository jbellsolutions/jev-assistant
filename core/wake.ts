/** "Hey Jev" — the wake word, and the small state machine around it.
 *
 *  Two things make this cheap rather than a project of its own:
 *
 *  1. **No VAD, no Whisper, no Python sidecar, no model download.** server/stt/apple.ts already
 *     emits `final: true` on the helper's own ~700 ms silence recycle. v6/M5.5 deliberately
 *     forced `speechFinal: false` because that signal was splitting dictation mid-sentence — but
 *     that same signal *is* a phrase boundary, which is exactly what a wake word needs. Each
 *     `final` fragment is a phrase to test against the regex.
 *  2. **The mishearings are the feature.** No recogniser reliably hears "Jev": it comes back as
 *     jeff, jeb, chev, jav. hey-jev's regex accepts all of them, and so does this one — a wake
 *     word that only fires on the correct spelling does not fire.
 *
 *  Pure: no host imports (test/core-boundary.test.ts). */
import { withoutTags } from "./lines.js";

/** How long a bare "Hey Jev" stays armed for the command that follows. Long enough to say "Yes?"
 *  and be answered; short enough that a conversation across the room is not a command. */
export const WAKE_WINDOW_MS = 6_000;

/** Leading greeting + the name, with every way a recogniser mangles it. Anchored at the start: a
 *  wake word buried mid-sentence is someone talking ABOUT Jev, not to it. */
export const WAKE = /^\W*(?:hey|hi|hay|okay|ok|hello|a|yo)\W+(?:jev|jevs|jeff|jeffs|jef|jeb|jeb's|jab|chev|jeve|jav|javs|gev|dev)\b\W*/i;

/** The bare name on its own also wakes her — people drop the greeting after the first time. */
export const BARE_NAME = /^\W*(?:jev|jeff|jeb|chev|jav)\b\W*$/i;

/** Seeds for the recogniser's own biasing. Apple takes these as `contextualStrings`
 *  (native/jev-speech/main.swift:126, already forwarded by server/stt/apple.ts) and ElevenLabs as
 *  `keyterms` — so the engine is told the name before it has to hear it. */
export const WAKE_KEYWORDS = ["Jev", "Hey Jev"];

export interface WakeMatch {
  /** Everything after the wake word: the command, when it came in one breath. */
  rest: string;
  /** True when only the wake word was said, so Jev should answer and listen. */
  bare: boolean;
}

/** Test one phrase for the wake word. Null when it was not addressed to Jev at all. */
export function matchWake(text: string): WakeMatch | null {
  const t = text.trim();
  if (!t) return null;
  const m = WAKE.exec(t);
  if (m) {
    const rest = t.slice(m[0].length).replace(/^[\s.,!?]+|[\s.,!?]+$/g, "");
    return { rest, bare: !rest };
  }
  // "Jev, open Spotify" — the name with no greeting, but only when it is genuinely leading, so an
  // utterance that merely mentions her does not fire.
  if (BARE_NAME.test(t)) return { rest: "", bare: true };
  const lead = /^\W*(?:jev|jeff|jeb|chev|jav)\b[\s,]+(.+)$/i.exec(t);
  if (lead?.[1]) {
    const rest = lead[1].trim();
    return { rest, bare: !rest };
  }
  return null;
}

/** The greeting and the name, found ANYWHERE in the phrase rather than only at its start.
 *
 *  Apple's phrase boundaries are its own ~700 ms silence recycle, not sentence boundaries. So when
 *  somebody is already mid-sentence as the name lands, the whole lot arrives as ONE phrase with the
 *  wake word in the middle of it — "so the deadline was thursday hey jev open spotify". A live run
 *  proved that anchoring the match there meant she did not wake AT ALL, and in a room that is the
 *  common case rather than an edge case: the anchor was testing where Apple happened to cut the
 *  audio, not whether she had been spoken to.
 *
 *  The bare name deliberately stays leading-only (see matchWake): "hey jev" in the middle of a
 *  sentence is an address, but "I'll ask Jev about it" is someone talking about her.
 *
 *  Three of the anchored spellings — `dev`, `gev`, `jab` — are left OUT here. Anchored, "hey dev" can
 *  only be an utterance addressed to her; unanchored, "...and hey, dev ops is down" is an ordinary
 *  sentence, and a false wake now runs a command. They still work when the phrase starts with them. */
const GREETED = /\b(?:hey|hi|hay|okay|ok|hello|yo)\W{1,3}(?:jev|jevs|jeff|jeffs|jef|jeb|jeb's|chev|jeve|jav|javs)\b[\s.,!?]*/gi;

/** Like `matchWake`, but tolerant of whatever was said before the greeting. Used for the phrases a
 *  continuously-running recogniser produces, and to strip the wake word back out of an accurate
 *  transcript that was handed the audio from before it. */
export function findWake(text: string): WakeMatch | null {
  const t = text.trim();
  if (!t) return null;
  let last: RegExpExecArray | null = null;
  GREETED.lastIndex = 0;
  for (let m = GREETED.exec(t); m; m = GREETED.exec(t)) last = m;
  if (last) {
    const rest = t.slice(last.index + last[0].length).replace(/^[\s.,!?]+|[\s.,!?]+$/g, "");
    return { rest, bare: !rest };
  }
  return matchWake(t);
}

/** The wake state machine.
 *
 *  Deliberately tiny and time-injected: "armed" is a deadline, not a timer, so nothing has to be
 *  cancelled and a stalled event loop cannot leave the microphone live forever. */
export class Wake {
  private armedUntil = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs = WAKE_WINDOW_MS,
  ) {}

  get armed(): boolean {
    return this.now() < this.armedUntil;
  }

  /** Arm for the window — after answering a bare "Hey Jev", or while a reply is expected. */
  arm(): void {
    this.armedUntil = this.now() + this.windowMs;
  }

  disarm(): void {
    this.armedUntil = 0;
  }

  /** What to do with one finished phrase.
   *
   *  - `ignore`   — not for Jev, and she is not armed. The overwhelmingly common case in a room.
   *  - `answer`   — a bare "Hey Jev": say "Yes?" and arm.
   *  - `command`  — a command to run, either after the wake word in one breath or inside the window.
   */
  hear(text: string): { kind: "ignore" } | { kind: "answer" } | { kind: "command"; text: string } {
    const m = findWake(text);
    if (m) {
      if (m.bare) {
        this.arm();
        return { kind: "answer" };
      }
      this.disarm();
      return { kind: "command", text: m.rest };
    }
    if (this.armed) {
      // One command per arming: without this, a room that keeps talking keeps being obeyed.
      this.disarm();
      const t = text.trim();
      return t ? { kind: "command", text: t } : { kind: "ignore" };
    }
    return { kind: "ignore" };
  }
}

/** Drop a line Jev has just said from the front of what was heard.
 *
 *  She answers a bare "Hey Jev" out loud, and the microphone is open while she does. The buffer keeps
 *  that moment on purpose (a command spoken over her must survive), so her own answer can end up at
 *  the front of the accurate transcript. Rather than trusting the browser's echo cancellation to have
 *  removed it — it compares against Chromium's own output, and the voice plays out of a separate
 *  process — this removes the words she is known to have said. */
export function stripSpoken(text: string, spoken: string): string {
  // Her lines carry Fish emotion tags ("[cheerful] Mm-hm?"); those are delivery for the voice model,
  // never sound, so they must not be looked for in what the microphone heard.
  const words = withoutTags(spoken).toLowerCase().match(/[a-z0-9']+/g);
  if (!words?.length) return text.trim();
  const pattern = new RegExp(`^\\W*${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\W+")}\\b[\\s.,!?]*`, "i");
  return text.replace(pattern, "").trim();
}
