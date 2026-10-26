import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LINES, WARM_APPS, line, warmableLines } from "../core/lines.js";
import { MAX_SPOKEN, clipSpoken, speakableText, spokenPart, spokenSummary } from "../core/speak.js";
import type { CommandResult } from "../core/results.js";
import { GatedSpeaker, SpeechGate } from "../server/speak/gate.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("what is worth saying aloud", () => {
  it("reads a URL as its host, not its path", () => {
    expect(speakableText("Opened https://en.wikipedia.org/wiki/Katherine_Johnson?x=1")).toBe("Opened en.wikipedia.org");
    expect(speakableText("see  https://www.example.com/a/b  now")).toBe("see example.com now");
  });

  it("drops markdown and cuts on a word boundary, not mid-word", () => {
    expect(clipSpoken("**Done.** `opened` _slack_")).toBe("Done. opened slack");
    const long = clipSpoken(`${"alpha ".repeat(60)}omega`);
    expect(long.length).toBeLessThanOrEqual(MAX_SPOKEN);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toMatch(/alph…$/);
  });
});

describe("spokenPart", () => {
  it("takes the lead paragraph when the answer has one", () => {
    // This is the contract server/hermes.ts restores in BRAIN_INSTRUCTIONS when a voice is on:
    // lead with the spoken reply, put detail after a blank line.
    expect(spokenPart("You have two meetings today.\n\n- Standup at nine\n- Lunch with Sam at noon")).toBe("You have two meetings today.");
  });

  it("reads the detail too when the lead is too short to be an answer on its own", () => {
    // The 20-character floor is deliberate: a lead that short is as likely to be an
    // acknowledgement ("Sure.", "Okay.") as the answer, and reading only that would sound like
    // Jev ignored the question. Below the floor, the whole thing is spoken.
    expect(spokenPart("Sure.\n\nThe price is $19 a month.")).toBe("Sure. The price is $19 a month.");
    expect(spokenPart("Two meetings today.\n\n- Standup at nine")).toBe("Two meetings today. Standup at nine");
  });

  it("cuts a long single paragraph at a sentence boundary", () => {
    const part = spokenPart(`${"This sentence is roughly fifty characters long, truly. ".repeat(6)}`);
    expect(part.length).toBeLessThanOrEqual(MAX_SPOKEN);
    expect(part.endsWith(".")).toBe(true);
  });
});

describe("spokenSummary", () => {
  // Same builders as test/summary.test.ts, because this is the same function with a voice's cap.
  const base = (over: Partial<CommandResult>): CommandResult => ({ ok: true, steps: [], page: { url: "https://a.com", title: "" }, pending: null, ...over });
  const step = (text: string, level: "ok" | "warn" | "error" = "ok", stepId = 1) => ({ stepId, command: "c", decision: null, result: { text, level } });

  it("is core/summary.ts's one-liner, so the two can never drift apart", () => {
    expect(spokenSummary(base({ steps: [step("Opened https://wikipedia.org")] }))).toBe("Opened wikipedia.org");
  });

  it("reads the question back when a command is waiting on one", () => {
    expect(spokenSummary(base({ ok: false, pending: { kind: "confirm", actionLabel: "Click Delete account", reason: "This looks hard to undo." } }))).toBe("Click Delete account? This looks hard to undo.");
  });

  it("honours a real voice's longer cap", () => {
    const long = `${"This sentence is about fifty characters long, truly. ".repeat(5)}`;
    // `say` earned 160 characters; a real voice earns FISH_MAX_CHARS, so the same outcome is read
    // out more fully rather than being cut off after a sentence and a half.
    const short = spokenSummary(base({ steps: [step(long)] }));
    const full = spokenSummary(base({ steps: [step(long)] }), 600);
    expect(short.length).toBeLessThanOrEqual(MAX_SPOKEN);
    expect(full.length).toBeGreaterThan(short.length);
    expect(full.length).toBeLessThanOrEqual(600);
  });
});

describe("the scripted line table", () => {
  it("fills placeholders and picks deterministically when asked", () => {
    expect(line("wake", {}, () => 0)).toBe("Yes?");
    expect(line("app_open", { app: "Slack" }, () => 0)).toBe("[cheerful] Slack's up.");
    expect(line("app_volume_set", { app: "Spotify", level: "quiet" }, () => 0)).toBe("Spotify's set to quiet.");
  });

  it("clamps an out-of-range pick rather than saying nothing", () => {
    expect(line("wake", {}, () => 99)).toBe(LINES.wake!.at(-1));
    expect(line("wake", {}, () => -5)).toBe(LINES.wake![0]);
  });

  it("refuses a key it has no line for, instead of falling silent", () => {
    // Silence is the failure mode this project keeps getting bitten by: an action that worked but
    // said nothing is indistinguishable from one that did nothing.
    expect(() => line("no_such_key")).toThrow(/no scripted line for "no_such_key"/);
  });

  it("leaves an unknown placeholder visible rather than printing 'undefined'", () => {
    expect(line("app_open", {}, () => 1)).toBe("{app}, opening now.");
  });

  it("offers every reply in more than one wording, so Jev does not sound like a recording", () => {
    const single = Object.entries(LINES).filter(([, v]) => v.length < 2).map(([k]) => k);
    // a handful are genuinely one-of-a-kind; the bulk must not be
    expect(single.length).toBeLessThan(Object.keys(LINES).length / 4);
  });
});

describe("what can be pre-rendered", () => {
  const warm = warmableLines();

  it("expands every closed-vocabulary placeholder and leaves none behind", () => {
    expect(warm.length).toBeGreaterThan(200);
    for (const l of warm) expect(l).not.toMatch(/\{\w+\}/);
    expect(warm).toContain("[cheerful] Slack's up.");
    for (const app of WARM_APPS) expect(warm).toContain(`Turning ${app} down.`);
  });

  it("skips open-ended lines rather than trying to cache every possible value", () => {
    // "{left} left." over every duration is not a cache, it is a bill.
    expect(warm.some((l) => l.includes(" left."))).toBe(false);
    expect(warm.some((l) => l.startsWith("Reminder:"))).toBe(false);
    // and the fixed part of those same keys is still warmed
    expect(warm).toContain("Timer cancelled.");
  });

  it("deduplicates, so two keys sharing a wording are rendered once", () => {
    expect(new Set(warm).size).toBe(warm.length);
  });
});

describe("the self-hearing gate", () => {
  const mk = (tail = 300) => {
    let now = 1000;
    const gate = new SpeechGate(() => now, tail);
    return { gate, tick: (ms: number) => void (now += ms) };
  };

  it("stays deaf until the LAST overlapping line has finished", () => {
    // Counting rather than holding a boolean is the whole point: M5 made overlapping speech ordinary
    // (a timer alert fires while an answer is being read), and a boolean would un-deafen the
    // microphone the moment the first of them ended, with audio still coming out.
    const { gate, tick } = mk();
    gate.begin();
    gate.begin();
    gate.end();
    expect(gate.speaking).toBe(true);
    expect(gate.deaf()).toBe(true);
    gate.end();
    expect(gate.speaking).toBe(false);
    expect(gate.deaf()).toBe(true); // ...still deaf for the room's echo
    tick(301);
    expect(gate.deaf()).toBe(false);
  });

  it("announces the start and the end once each, not once per line", () => {
    // The panel's indicator is driven from this. Reporting per utterance is what blanks it while she
    // is still talking — and then Escape hides the panel instead of shutting her up.
    const { gate } = mk();
    const changes: boolean[] = [];
    gate.onChange((s) => changes.push(s));
    gate.begin();
    gate.begin();
    gate.end();
    gate.end();
    expect(changes).toEqual([true, false]);
  });

  it("stops telling a listener that has gone away", () => {
    const { gate } = mk();
    const changes: boolean[] = [];
    const off = gate.onChange((s) => changes.push(s));
    gate.begin();
    off();
    gate.end();
    expect(changes).toEqual([true]);
  });

  it("closes the gate around anything a voice says, whether or not it succeeds", async () => {
    const { gate } = mk();
    const seen: boolean[] = [];
    gate.onChange((s) => seen.push(s));
    const speaker = new GatedSpeaker(
      {
        speak: async () => {
          expect(gate.deaf()).toBe(true); // deaf DURING the line, not after it
          throw new Error("fish is down");
        },
        stop: () => {},
      },
      gate,
    );
    await expect(speaker.speak("hello")).rejects.toThrow(/fish is down/);
    expect(gate.speaking).toBe(false); // and the gate reopens even when the voice failed
    expect(seen).toEqual([true, false]);
  });

  it("leaves the microphone open while pre-rendering, which plays nothing", async () => {
    const { gate } = mk();
    const prepared: string[] = [];
    const speaker = new GatedSpeaker({ speak: async () => {}, stop: () => {}, prepare: async (t: string) => void prepared.push(t) }, gate);
    await speaker.prepare("Time's up.");
    expect(prepared).toEqual(["Time's up."]);
    expect(gate.deaf()).toBe(false);
  });
});
