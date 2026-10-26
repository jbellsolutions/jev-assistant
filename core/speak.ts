/** Spoken replies: what is worth saying aloud, and how much of it.
 *
 *  Restored from commit 18cdbc2^ ("Remove TTS/voice-output entirely"). The reason it was removed
 *  was the user's verdict on the voice itself — "the audio sucks and it's very robotic… it's moving
 *  slowly" — not this shaping logic, which was fine. The voice is fixed in server/speak/fish.ts
 *  (a real voice) and server/speak/warm.ts (every scripted line pre-rendered to disk, so a reply
 *  is a local file play rather than a round trip).
 *
 *  `Speaker` lives here rather than under server/ so core keeps no host dependency — the same
 *  arrangement as `Computer` in core/session.ts. test/core-boundary.test.ts enforces it.
 *
 *  Deliberately NOT redefining the old `spokenSummary`: core/summary.ts survived that commit and
 *  its `resultSummary` is the same function with a different default cap. Callers that want a
 *  spoken outcome use `resultSummary(r, MAX_SPOKEN)`. */
import { resultSummary } from "./summary.js";
import type { CommandResult } from "./results.js";

export interface Speaker {
  /** Say `text`, resolving when it has been spoken (or was interrupted). */
  speak(text: string, signal?: AbortSignal): Promise<void>;
  stop(): void;
  /** Render this line to the cache WITHOUT playing it, if the voice can.
   *
   *  This is what makes a timer's alert instant: hey-jev renders the reminder's audio while the
   *  timer is still counting down, so firing is a local file play rather than a synthesis the user
   *  waits through. Optional, because a voice that cannot pre-render is still a voice. */
  prepare?(text: string): Promise<void>;
  /** How much of an answer is worth reading aloud with this voice (a robotic voice earns less). */
  readonly maxChars?: number;
}

export const MAX_SPOKEN = 160;

/** URLs read aloud are noise: keep the host ("wikipedia.org"), drop scheme, path and query. */
export function speakableText(text: string): string {
  return text
    .replace(/\{\{secret:[^}]*\}\}/g, "a secret") // a key's handle is never read out
    .replace(/https?:\/\/(?:www\.)?([^\s/?#]+)[^\s]*/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Shorten free text (a brain reply, an outcome) to something worth saying aloud. */
export function clipSpoken(text: string, max = MAX_SPOKEN): string {
  const t = speakableText(text.replace(/[*_`#>]+/g, ""));
  return t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

/** The part of an answer to read aloud: the assistant is asked to lead with a short spoken reply
 *  and put detail after a blank line, so the first paragraph is it when it fits; long single
 *  paragraphs are cut at a sentence boundary instead of mid-word.
 *
 *  That lead-sentence contract is a real coupling, not a hope: it lives in the brain's system
 *  prompt, and v5 replaced it with "this is a text surface, not voice". server/hermes.ts restores
 *  it whenever a speaker is configured — without that, this function clips markdown. */
export function spokenPart(text: string, max = MAX_SPOKEN): string {
  const plain = speakableText(text.replace(/[*_`#>]+/g, "").replace(/^\s*[-•]\s+/gm, ""));
  const first = text.trim().split(/\r?\n\s*\r?\n/)[0] ?? "";
  const lead = speakableText(first.replace(/[*_`#>]+/g, "").replace(/^\s*[-•]\s+/gm, ""));
  const candidate = lead && lead.length <= max && lead.length >= Math.min(plain.length, 20) ? lead : plain;
  if (candidate.length <= max) return candidate;
  const cut = candidate.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return boundary >= max / 3 ? cut.slice(0, boundary + 1) : clipSpoken(candidate, max);
}

/** The spoken form of a finished command: the same one-liner /api/ask gets, capped for a voice. */
export function spokenSummary(r: CommandResult, max = MAX_SPOKEN): string {
  return resultSummary(r, max);
}
