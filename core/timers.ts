/** Timers and reminders: "set a timer for ten minutes", "remind me in 20 minutes to call Bob".
 *
 *  Spoken durations are a text problem, not a model problem — "twenty five minutes" and "half an
 *  hour" are deterministic, and a model round trip to parse them would be slower and less reliable
 *  than a regex. Modelled on hey-jev's `_digits`/`DURATION`/`NUMBER_WORDS`, which solves exactly
 *  this and solves it well.
 *
 *  Pure: no timers are actually scheduled here (that is server-side), only parsed and described.
 *  Keeps test/core-boundary.test.ts happy and makes every case testable without waiting. */

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
};

const UNIT_SECONDS: Record<string, number> = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
};

const DURATION = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b(\s+and\s+a\s+half)?/g;

/** "twenty five minutes" -> "25 minutes"; "half an hour" -> "30 minutes"; "a couple of mins" -> "2 mins". */
export function toDigits(text: string): string {
  let t = text.toLowerCase();
  t = t.replace(/\bhalf an?\s+hour\b/g, "30 minutes");
  t = t.replace(/\bhalf a\s+minute\b/g, "30 seconds");
  t = t.replace(/\ba couple of\b/g, "couple");
  // the leading article is consumed too, or "a few seconds" leaves a stray "a 3 seconds"
  t = t.replace(/\b(?:a\s+)?(an?|few|couple)\s+(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/g, (_m, word: string, unit: string) => `${{ a: 1, an: 1, few: 3, couple: 2 }[word] ?? 1} ${unit}`);

  const words = t.replace(/-/g, " ").split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.replace(/[,.!?]+$/, "");
    const n = NUMBER_WORDS[w];
    if (n === undefined) {
      out.push(words[i]!);
      continue;
    }
    // "twenty five" is one number, "twenty minutes five seconds" is two
    const next = words[i + 1]?.replace(/[,.!?]+$/, "") ?? "";
    const m = NUMBER_WORDS[next];
    if (n >= 20 && m !== undefined && m < 10) {
      out.push(String(n + m));
      i++;
    } else out.push(String(n));
  }
  return out.join(" ");
}

/** Total seconds named in the sentence, or null. Adds up "one hour and thirty minutes". */
export function parseDuration(text: string): number | null {
  let total = 0;
  for (const m of toDigits(text).matchAll(DURATION)) {
    const unit = UNIT_SECONDS[m[2]!];
    if (unit === undefined) continue;
    total += Number(m[1]) * unit + (m[3] ? unit / 2 : 0);
  }
  return total > 0 ? Math.round(total) : null;
}

const LABEL = /\b(?:to|that|about|for)\s+(.+)$/;
const REMINDER_LEAD = /^.*?\bremind\s+(?:me|us)\b\s*/i;

/** "remind me in 20 minutes to call Bob" -> { seconds: 1200, label: "call Bob" }.
 *
 *  The label is what gets read back ("Hey, just a reminder: call Bob"), so it keeps the user's own
 *  words rather than being summarised — and it is deliberately cut AFTER the duration, so
 *  "remind me in 5 minutes" alone yields no label instead of the word "minutes". */
export function parseReminder(text: string): { seconds: number; label: string | null } | null {
  const seconds = parseDuration(text);
  if (seconds === null) return null;
  // The label is read back out loud — "Hey, just a reminder: call Bob" — so it is taken from the
  // ORIGINAL text, not from toDigits' lowercased copy, which would say "call bob" and flatten
  // every proper noun in it.
  const tail = /\b(?:hours?|hrs?|minutes?|mins?|seconds?|secs?|h|m|s)\b(?!.*\b(?:hours?|hrs?|minutes?|mins?|seconds?|secs?)\b)/i.exec(text);
  const after = tail ? text.slice(tail.index + tail[0].length) : text;
  const stripped = after.replace(/^\s*(?:and\s+a\s+half\b\s*)?/i, "").trim();
  const m = LABEL.exec(stripped);
  const label = (m?.[1] ?? "").replace(/[.!?]+$/, "").trim();
  return { seconds, label: label || null };
}

/** True when the utterance is asking for a reminder rather than a bare timer. */
export function isReminder(text: string): boolean {
  return REMINDER_LEAD.test(text.trim());
}

const PLURAL = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "1500" -> "25 minutes"; "3665" -> "1 hour and 1 minute". What Jev says out loud, so it rounds
 *  the way a person would rather than reading out "3665 seconds". */
export function sayDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return PLURAL(s, "second");
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const parts: string[] = [];
  if (hours) parts.push(PLURAL(hours, "hour"));
  if (minutes) parts.push(PLURAL(minutes, "minute"));
  // seconds are only worth saying when they are the whole story or the tail of a short timer
  if (rest && !hours) parts.push(PLURAL(rest, "second"));
  if (!parts.length) return PLURAL(s, "second");
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export interface Timer {
  id: number;
  /** Absolute epoch ms, so a paused event loop or a slow step cannot make it drift. */
  dueAt: number;
  seconds: number;
  label: string | null;
}

/** What the panel renders and what "how long is left?" answers from. Pure bookkeeping — the host
 *  owns the actual setTimeout, so every case here is testable without waiting for real time. */
export class TimerStore {
  private next = 1;
  private timers: Timer[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  add(seconds: number, label: string | null = null): Timer {
    const timer: Timer = { id: this.next++, dueAt: this.now() + seconds * 1000, seconds, label };
    this.timers.push(timer);
    return timer;
  }

  /** Soonest first, so "how long is left?" answers about the one that matters. */
  active(): Timer[] {
    const t = this.now();
    return this.timers.filter((x) => x.dueAt > t).sort((a, b) => a.dueAt - b.dueAt);
  }

  remaining(timer: Timer): number {
    return Math.max(0, Math.round((timer.dueAt - this.now()) / 1000));
  }

  /** Remove one timer (the soonest, when unspecified) and say whether there was one. */
  cancel(id?: number): Timer | null {
    const target = id === undefined ? this.active()[0] : this.timers.find((t) => t.id === id);
    if (!target) return null;
    this.timers = this.timers.filter((t) => t !== target);
    return target;
  }

  cancelAll(): number {
    const n = this.active().length;
    this.timers = [];
    return n;
  }

  /** Timers that have come due, removed from the store as they are handed back. */
  fire(): Timer[] {
    const t = this.now();
    const due = this.timers.filter((x) => x.dueAt <= t);
    this.timers = this.timers.filter((x) => x.dueAt > t);
    return due;
  }
}
