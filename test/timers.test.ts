import { describe, expect, it } from "vitest";
import { TimerStore, isReminder, parseDuration, parseReminder, sayDuration, toDigits } from "../core/timers.js";

describe("hearing a duration", () => {
  it("turns spoken numbers into digits", () => {
    expect(toDigits("twenty five minutes")).toBe("25 minutes");
    expect(toDigits("half an hour")).toBe("30 minutes");
    expect(toDigits("a couple of minutes")).toBe("2 minutes");
    expect(toDigits("a few seconds")).toBe("3 seconds");
    // "twenty minutes five seconds" is two numbers, not "twenty five"
    expect(toDigits("twenty minutes five seconds")).toBe("20 minutes 5 seconds");
  });

  it("reads every way someone says how long", () => {
    expect(parseDuration("set a timer for 10 seconds")).toBe(10);
    expect(parseDuration("twenty five minutes")).toBe(1500);
    expect(parseDuration("half an hour")).toBe(1800);
    expect(parseDuration("an hour and a half")).toBe(5400);
    expect(parseDuration("1 hour and 30 minutes")).toBe(5400);
    expect(parseDuration("90 mins")).toBe(5400);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("a couple of minutes")).toBe(120);
  });

  it("says nothing rather than guessing when no duration was given", () => {
    expect(parseDuration("set a timer")).toBeNull();
    expect(parseDuration("remind me to call mum")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });
});

describe("hearing a reminder", () => {
  it("keeps the user's own words as the label", () => {
    // The label is read back out loud, so summarising it would put words in the user's mouth.
    expect(parseReminder("remind me in 20 minutes to call Bob")).toEqual({ seconds: 1200, label: "call Bob" });
    expect(parseReminder("remind me in half an hour to take the bread out")).toEqual({ seconds: 1800, label: "take the bread out" });
    expect(parseReminder("remind me in 5 mins about the standup")).toEqual({ seconds: 300, label: "the standup" });
  });

  it("has no label when none was given, rather than the word 'minutes'", () => {
    // The label is cut AFTER the duration on purpose; cutting before it produced "minutes".
    expect(parseReminder("set a timer for 10 minutes")).toEqual({ seconds: 600, label: null });
    expect(parseReminder("remind me in 5 minutes")).toEqual({ seconds: 300, label: null });
  });

  it("knows a reminder from a bare timer", () => {
    expect(isReminder("remind me in 20 minutes to call Bob")).toBe(true);
    expect(isReminder("hey jev remind me in 5 to stretch")).toBe(true);
    expect(isReminder("set a timer for 10 minutes")).toBe(false);
  });
});

describe("saying a duration back", () => {
  it("rounds the way a person would", () => {
    expect(sayDuration(10)).toBe("10 seconds");
    expect(sayDuration(1)).toBe("1 second");
    expect(sayDuration(90)).toBe("1 minute and 30 seconds");
    expect(sayDuration(1500)).toBe("25 minutes");
    expect(sayDuration(3600)).toBe("1 hour");
    expect(sayDuration(5400)).toBe("1 hour and 30 minutes");
    // nobody wants "1 hour, 1 minute and 5 seconds" out loud
    expect(sayDuration(3665)).toBe("1 hour and 1 minute");
    expect(sayDuration(0)).toBe("0 seconds");
  });
});

describe("keeping track of timers", () => {
  const store = (start = 1_000_000) => {
    let now = start;
    return { s: new TimerStore(() => now), tick: (ms: number) => (now += ms) };
  };

  it("counts down against the clock, not against a tick loop", () => {
    // Absolute due times: a busy event loop or a long step cannot make a timer drift late.
    const { s, tick } = store();
    const t = s.add(600);
    expect(s.remaining(t)).toBe(600);
    tick(60_000);
    expect(s.remaining(t)).toBe(540);
    tick(600_000);
    expect(s.remaining(t)).toBe(0);
  });

  it("answers 'how long is left' about the one that matters", () => {
    const { s } = store();
    s.add(600, "bread");
    s.add(60, "tea");
    expect(s.active().map((t) => t.label)).toEqual(["tea", "bread"]);
  });

  it("fires each timer exactly once", () => {
    const { s, tick } = store();
    s.add(10, "a");
    s.add(30, "b");
    expect(s.fire()).toEqual([]);
    tick(10_000);
    expect(s.fire().map((t) => t.label)).toEqual(["a"]);
    expect(s.fire()).toEqual([]); // not again
    tick(30_000);
    expect(s.fire().map((t) => t.label)).toEqual(["b"]);
    expect(s.active()).toEqual([]);
  });

  it("cancels the soonest by default, and says when there was nothing to cancel", () => {
    const { s } = store();
    s.add(600, "bread");
    s.add(60, "tea");
    expect(s.cancel()?.label).toBe("tea");
    expect(s.cancelAll()).toBe(1);
    expect(s.cancel()).toBeNull();
    expect(s.cancelAll()).toBe(0);
  });
});
