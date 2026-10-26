/** Jev's scripted replies.
 *
 *  Why a fixed table rather than asking a model for a sentence: every line here is pre-rendered to
 *  disk at startup (server/speak/warm.ts), so answering out loud is an `afplay` of a cached file
 *  rather than a network round trip. That is the whole fix for the verdict that killed voice output
 *  in v4 — "the audio sucks and it's very robotic… it's moving slowly". A finite table is what
 *  makes the cache possible, so keep it finite: anything with an open-ended placeholder cannot be
 *  warmed and pays full latency on first use.
 *
 *  Shape borrowed from hey-jev's REPLIES (several per key, picked at random so it doesn't sound
 *  like a recording), including Fish Audio's inline emotion tags — `[cheerful]`, `[chuckling]`,
 *  `[sighing]` — which the model reads as delivery, not as words.
 *
 *  Pure: no host imports (test/core-boundary.test.ts). */

/** Levels `volume_set` understands — a closed vocabulary precisely so every line is warmable. */
export const LEVELS = ["silent", "quiet", "half", "loud", "max"] as const;
export type Level = (typeof LEVELS)[number];

/** Apps common enough to be worth pre-rendering "…'s up" for. Anything else still works, it just
 *  synthesizes on first use. Mirrors the head of MAC_APPS in core/route.ts. */
export const WARM_APPS = ["Slack", "Spotify", "Chrome", "Safari", "Mail", "Messages", "Notes", "Calendar", "Finder", "Terminal"] as const;

export const LINES: Record<string, readonly string[]> = {
  app_open: ["[cheerful] {app}'s up.", "{app}, opening now.", "[chuckling] There you go, {app}."],

  volume_up: ["Louder it is.", "[cheerful] Turning it up.", "Up we go."],
  volume_down: ["Bringing it down.", "[sighing] A little quieter.", "Turning it down."],
  volume_mute: ["[sighing] Muting. Finally some quiet.", "Muted.", "Shh. Muted."],
  volume_unmute: ["Sound's back.", "[cheerful] Unmuted.", "And we're back."],
  volume_set: ["Set to {level}.", "Volume's {level} now."],

  app_volume_up: ["Turning {app} up.", "[cheerful] {app}'s louder."],
  app_volume_down: ["Turning {app} down.", "{app}'s a little quieter."],
  app_volume_mute: ["{app}'s muted.", "[sighing] Muting {app}."],
  app_volume_unmute: ["{app}'s sound is back.", "[cheerful] {app}'s unmuted."],
  app_volume_set: ["{app}'s set to {level}.", "Set {app} to {level}."],

  display_dark_on: ["[chuckling] Lights off.", "Dark mode on.", "Going dark."],
  display_dark_off: ["[cheerful] Let there be light.", "Dark mode off.", "Back to light."],
  display_toggle: ["Flipped it.", "There, switched."],

  media_play: ["[cheerful] Playing.", "Music's on.", "Here we go."],
  media_pause: ["Paused.", "[sighing] Pausing. Take your time.", "Holding it there."],
  media_next: ["Skipping.", "[chuckling] Not a fan? Next one.", "Next track."],
  media_previous: ["Going back one.", "Previous track.", "[chuckling] Again? Sure."],

  system_lock: ["Locking up. See you soon.", "Locked.", "Screen's locked."],
  system_sleep: ["Good night.", "Sleeping now.", "[sighing] Finally, a nap."],

  timer_set: ["[cheerful] Timer's set.", "On it. I'll let you know.", "Done, counting down."],
  timer_check: ["{left} left.", "You've got {left} to go."],
  timer_cancel: ["Timer cancelled.", "[sighing] Fine, no timer then."],
  timers_cancel: ["All timers cancelled.", "Cleared them all."],
  timer_none: ["[chuckling] There's no timer running."],
  timer_unclear: ["[clear throat] How long for?"],
  timer_done: ["[cheerful] Time's up!", "[chuckling] Ding ding, time's up."],
  reminder_set: ["Got it, I'll remind you.", "[cheerful] Sure, I'll give you a shout."],
  reminder_done: ["[cheerful] Hey, just a reminder: {label}.", "Reminder: {label}."],

  wake: ["Yes?", "[cheerful] Mm-hm?", "I'm listening."],
  working: ["On it.", "[cheerful] Working on it."],
  compound_done: ["[chuckling] Done, both of them.", "[cheerful] All done.", "Both sorted."],
  clarify: ["[clear throat] Sorry, say that again?", "Hm, one more time?"],
  give_up: ["[sighing] I'm not sure what you mean. Try saying it differently?"],
  unsupported: ["[chuckling] I know what you want, I just can't do that one yet."],
};

export type LineKey = keyof typeof LINES;

/** Substitutions a line may ask for. */
export interface LineVars {
  app?: string;
  level?: string;
  left?: string;
  label?: string;
}

const PLACEHOLDER = /\{(\w+)\}/g;

function fill(template: string, vars: LineVars): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = (vars as Record<string, string | undefined>)[name];
    return value ?? whole;
  });
}

/** One line for `key`, placeholders filled. `pick` is injectable so tests are deterministic and
 *  the warm pass can walk every variant rather than sampling. */
export function line(key: string, vars: LineVars = {}, pick: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  const options = LINES[key];
  if (!options?.length) throw new Error(`no scripted line for "${key}" — add it to core/lines.ts rather than saying nothing`);
  const chosen = options[Math.min(Math.max(pick(options.length), 0), options.length - 1)]!;
  return fill(chosen, vars);
}

/** Every line that can be rendered ahead of time, deduplicated.
 *
 *  A line whose placeholders are not drawn from a closed vocabulary (`{left}`, `{label}`) is
 *  skipped: pre-rendering "3 minutes left" for every possible duration is not a cache, it is a
 *  denial-of-service on the free tier. Those pay synthesis once, at the moment they are needed —
 *  and for a reminder that cost is hidden entirely, because the alert is rendered while the timer
 *  is still running (see core/timers.ts). */
export function warmableLines(): string[] {
  const out = new Set<string>();
  for (const options of Object.values(LINES)) {
    for (const template of options) {
      const names = [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);
      if (!names.length) {
        out.add(template);
        continue;
      }
      if (names.some((n) => n !== "app" && n !== "level")) continue;
      const apps = names.includes("app") ? WARM_APPS : [undefined];
      const levels = names.includes("level") ? LEVELS : [undefined];
      for (const app of apps) for (const level of levels) out.add(fill(template, { app, level }));
    }
  }
  return [...out];
}

/** Fish Audio reads `[cheerful]`, `[chuckling]`, `[sighing]` as delivery, not as words — but they
 *  are still literal text, and anything that DISPLAYS a line must drop them first. Without this
 *  the panel's status reads "[cheerful] Spotify's louder." and Hermes receives the tags through
 *  /api/ask and MCP. */
export function withoutTags(text: string): string {
  return text
    .replace(/\[[a-z][a-z ]{0,20}\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}
