import { describe, expect, it } from "vitest";
import { splitSteps } from "../core/commands.js";
import { LEVEL_PERCENT, type Control, controlHeuristically, controlRequest, describeControl, lineKey, lineVars, mightBeControl, playerScope, speakFirst, startsWithControl } from "../core/controls.js";
import { LINES } from "../core/lines.js";
import { isSleepCommand } from "../core/route.js";

/** Every phrase the user would actually say. Measured against the real decider before this existed:
 *  all of these landed on `hermes` at low confidence, and "previous track" pressed the browser's
 *  BACK button. See review/decider-before.json. */
const CONTROLS = [
  "turn the volume down", "turn it up", "mute", "unmute", "turn the volume all the way down", "play", "pause",
  "pause the music", "next track", "skip this song", "previous track", "turn on dark mode", "dark mode off",
  "lock my computer", "put the computer to sleep", "turn spotify down", "louder", "quieter", "lock", "go to sleep",
];

/** Things that must stay exactly where they are. The browser fast lane is the expensive thing to
 *  break here, and the page ones are the traps: a page has play buttons and volume sliders. */
const NOT_CONTROLS = [
  "click the pricing link", "click the play button", "play the video on this page", "click the volume slider",
  "click next", "scroll down", "go back", "reload the page", "type hello and press enter", "open slack",
  "open my resume", "can you check my email", "find me 20 dentists in austin", "hey what's up",
  "turn on the porch light", "search for noise cancelling headphones", "google the weather in paris",
];

describe("recognising a device control", () => {
  it("matches everything said out loud to a Mac", () => {
    const missed = CONTROLS.filter((t) => !controlRequest(t));
    expect(missed).toEqual([]);
  });

  it("leaves the browser lane alone, including the phrases that look like controls", () => {
    const wrong = NOT_CONTROLS.filter((t) => controlRequest(t));
    expect(wrong).toEqual([]);
  });

  it("does not spend decider questions on ordinary browser work", () => {
    // mightBeControl gates the six extra questions. If it fired on "click the pricing link" the
    // browser fast lane would pay for a feature it never uses — measured flat at 156ms either way.
    expect(mightBeControl("click the pricing link")).toBe(false);
    expect(mightBeControl("open my resume")).toBe(false); // "resume" the file, not "resume playing"
    expect(mightBeControl("scroll down")).toBe(false);
    expect(mightBeControl("mute")).toBe(true);
    expect(mightBeControl("turn spotify down")).toBe(true); // the app sits between verb and direction
  });

  it("reads the app the user named", () => {
    expect(playerScope("turn spotify down")).toBe("spotify");
    expect(playerScope("mute apple music")).toBe("music");
    expect(playerScope("turn the volume down")).toBeUndefined();
  });
});

describe("splitting an utterance that contains a control", () => {
  it("splits the headline case, both ways round", () => {
    // Control first: without the exemption in core/session.ts the whole string decides as one
    // `computer` step and "open slack" vanishes. Control second: without startsWithControl the
    // utterance never splits at all. Both are the v4 P0 bug through different doors.
    expect(splitSteps("turn spotify down and open slack")).toEqual(["turn spotify down", "open slack"]);
    expect(splitSteps("open slack and mute")).toEqual(["open slack", "mute"]);
    expect(splitSteps("turn the volume down and play")).toEqual(["turn the volume down", "play"]);
    expect(splitSteps("mute and lock my computer")).toEqual(["mute", "lock my computer"]);
  });

  it("recognises a control at the start of a longer remainder", () => {
    expect(startsWithControl("mute and then lock my computer")).toBe(true);
    expect(startsWithControl("play the video on this page")).toBe(false);
  });

  it("does not split what it never split before", () => {
    expect(splitSteps("open slack and click general")).toEqual(["open slack", "click general"]);
    expect(splitSteps("search for cats and dogs")).toEqual(["search for cats and dogs"]);
    expect(splitSteps("type hello and press enter")).toEqual(["type hello and press enter"]);
    expect(splitSteps("open slack and leave a note for xander in the content channel")).toEqual(["open slack and leave a note for xander in the content channel"]);
    // a page with a video: "play the first video" is browser work and must stay attached
    expect(splitSteps("go to youtube and play the first video")).toEqual(["go to youtube and play the first video"]);
  });
});

describe("saying it before doing it", () => {
  it("speaks first for exactly the actions that would silence the reply", () => {
    // hey-jev's SPEAK_FIRST, plus the case its set misses by name: setting the volume to silent.
    expect(speakFirst({ target: "volume", action: "mute" })).toBe(true);
    expect(speakFirst({ target: "volume", action: "set", level: "silent" })).toBe(true);
    expect(speakFirst({ target: "system", action: "lock" })).toBe(true);
    expect(speakFirst({ target: "system", action: "sleep" })).toBe(true);

    expect(speakFirst({ target: "volume", action: "down" })).toBe(false);
    expect(speakFirst({ target: "volume", action: "set", level: "quiet" })).toBe(false);
    expect(speakFirst({ target: "media", action: "pause" })).toBe(false);
    expect(speakFirst({ target: "display", action: "dark_on" })).toBe(false);
  });
});

describe("what a control is called", () => {
  it("has a scripted line for every control it can produce", () => {
    // Silence is this project's recurring failure mode: an action that worked but said nothing
    // reads exactly like one that did nothing. `line()` throws on a missing key, so a control with
    // no line would be a runtime error in front of the user rather than a test failure here.
    const all: Control[] = [
      ...(["up", "down", "mute", "unmute"] as const).map((action) => ({ target: "volume", action }) as Control),
      { target: "volume", action: "set", level: "half" },
      ...(["up", "down", "mute", "unmute"] as const).map((action) => ({ target: "volume", action, scope: "spotify" }) as Control),
      { target: "volume", action: "set", level: "quiet", scope: "spotify" },
      ...(["play", "pause", "next", "previous"] as const).map((action) => ({ target: "media", action }) as Control),
      ...(["dark_on", "dark_off", "toggle"] as const).map((action) => ({ target: "display", action }) as Control),
      ...(["lock", "sleep"] as const).map((action) => ({ target: "system", action }) as Control),
    ];
    for (const c of all) {
      expect(LINES[lineKey(c)], `no line for ${lineKey(c)}`).toBeTruthy();
      expect(describeControl(c).length).toBeGreaterThan(3);
    }
  });

  it("names the app when the user did, because the generic line would be a lie", () => {
    expect(lineKey({ target: "volume", action: "down", scope: "spotify" })).toBe("app_volume_down");
    expect(lineKey({ target: "volume", action: "down" })).toBe("volume_down");
    expect(lineVars({ target: "volume", action: "set", level: "quiet", scope: "spotify" })).toEqual({ app: "Spotify", level: "quiet" });
    expect(lineVars({ target: "display", action: "dark_on" })).toEqual({});
    expect(describeControl({ target: "volume", action: "down", scope: "spotify" })).toBe("Turn Spotify down");
  });
});

describe("the keyword mirror (used by the whole hermetic test suite)", () => {
  it("agrees with the regex about what is a control", () => {
    const missed = CONTROLS.filter((t) => !controlHeuristically(t));
    expect(missed).toEqual([]);
    expect(NOT_CONTROLS.filter((t) => controlHeuristically(t))).toEqual([]);
  });

  it("reads the right action out of each phrase", () => {
    expect(controlHeuristically("turn the volume down")).toEqual({ target: "volume", action: "down" });
    expect(controlHeuristically("turn spotify down")).toEqual({ target: "volume", action: "down", scope: "spotify" });
    expect(controlHeuristically("turn the volume all the way down")).toEqual({ target: "volume", action: "set", level: "silent" });
    expect(controlHeuristically("mute")).toEqual({ target: "volume", action: "mute" });
    expect(controlHeuristically("unmute")).toEqual({ target: "volume", action: "unmute" });
    expect(controlHeuristically("next track")).toEqual({ target: "media", action: "next" });
    expect(controlHeuristically("previous track")).toEqual({ target: "media", action: "previous" });
    expect(controlHeuristically("pause")).toEqual({ target: "media", action: "pause" });
    expect(controlHeuristically("turn on dark mode")).toEqual({ target: "display", action: "dark_on" });
    expect(controlHeuristically("dark mode off")).toEqual({ target: "display", action: "dark_off" });
    expect(controlHeuristically("lock my computer")).toEqual({ target: "system", action: "lock" });
    expect(controlHeuristically("go to sleep")).toEqual({ target: "system", action: "sleep" });
  });
});

describe("collisions with commands that already existed", () => {
  it('no longer puts JEV to sleep when the user says "pause"', () => {
    // handleCommand checks isSleepCommand before anything else, so while bare "pause" was in that
    // list it could never reach the media lane — saying "pause" shut the assistant down.
    expect(isSleepCommand("pause")).toBe(false);
    expect(controlHeuristically("pause")).toEqual({ target: "media", action: "pause" });
    // every other way of saying it still works
    for (const t of ["go to sleep", "goodnight", "shut up", "that's all"]) expect(isSleepCommand(t)).toBe(true);
  });

  it("keeps the levels a closed, pre-renderable set", () => {
    expect(Object.keys(LEVEL_PERCENT)).toEqual(["silent", "quiet", "half", "loud", "max"]);
    expect(LEVEL_PERCENT.silent).toBe(0);
    expect(LEVEL_PERCENT.max).toBe(100);
  });
});

describe("timers, which are a control target but never a Mac capability", () => {
  it("hears every way of asking for one", () => {
    expect(controlHeuristically("set a timer for ten minutes")).toEqual({ target: "timer", action: "set", seconds: 600, label: null });
    expect(controlHeuristically("remind me in 20 minutes to call Bob")).toEqual({ target: "timer", action: "set", seconds: 1200, label: "call Bob" });
    expect(controlHeuristically("how long is left")).toEqual({ target: "timer", action: "check" });
    expect(controlHeuristically("cancel the timer")).toEqual({ target: "timer", action: "cancel" });
    expect(controlHeuristically("cancel all my timers")).toEqual({ target: "timer", action: "cancel_all" });
  });

  it("keeps the label's own capitalisation, because it is read back out loud", () => {
    // The heuristic works on a lowercased copy for matching; reading the label off that copy said
    // "call bob" and flattened every proper noun in it.
    expect(controlHeuristically("remind me in 5 minutes to email Sarah")).toMatchObject({ label: "email Sarah" });
  });

  it("leaves a clock time to the brain, which knows what five o'clock is", () => {
    // This lane can only represent a LENGTH. Claiming "remind me to call mom at five" would answer
    // "how long for?" to a perfectly clear request. Confirmed against the real decider: it stays
    // hermes@1.00 (review/decider-after.json).
    expect(controlHeuristically("remind me to call mom at five")).toBeUndefined();
    expect(controlHeuristically("remind me to buy milk")).toBeUndefined();
  });

  it("does not steal the stop words", () => {
    expect(controlRequest("stop")).toBe(false);
    expect(controlRequest("cancel that")).toBe(false);
    expect(controlHeuristically("never mind")).toBeUndefined();
  });

  it("has a scripted line for every timer outcome", () => {
    for (const key of ["timer_set", "reminder_set", "timer_check", "timer_cancel", "timers_cancel", "timer_none", "timer_unclear", "timer_done", "reminder_done"]) {
      expect(LINES[key], key).toBeTruthy();
    }
    expect(lineKey({ target: "timer", action: "set" })).toBe("timer_set");
    expect(lineKey({ target: "timer", action: "set", label: "call Bob" })).toBe("reminder_set");
    expect(lineKey({ target: "timer", action: "cancel_all" })).toBe("timers_cancel");
  });
});
