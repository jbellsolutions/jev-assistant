import { describe, expect, it } from "vitest";
import { WAKE_KEYWORDS, WAKE_WINDOW_MS, Wake, findWake, matchWake, stripSpoken } from "../core/wake.js";

describe("hearing the wake word", () => {
  it("accepts every way a recogniser mangles the name", () => {
    // This is the whole point. No recogniser reliably hears "Jev" — v7/M0 moved the user OFF Apple
    // over exactly this. A wake word that only fires on the correct spelling does not fire.
    for (const name of ["jev", "jeff", "jeb", "chev", "jav", "jeve", "gev"]) {
      expect(matchWake(`hey ${name}`), name).toEqual({ rest: "", bare: true });
    }
  });

  it("takes a command said in the same breath", () => {
    expect(matchWake("hey jev open spotify")).toEqual({ rest: "open spotify", bare: false });
    expect(matchWake("Hey Jeff, turn the volume down.")).toEqual({ rest: "turn the volume down", bare: false });
    expect(matchWake("ok jev what's on my calendar")).toEqual({ rest: "what's on my calendar", bare: false });
  });

  it("wakes on the bare name, with or without a command", () => {
    expect(matchWake("jev")).toEqual({ rest: "", bare: true });
    expect(matchWake("jev, open slack")).toEqual({ rest: "open slack", bare: false });
  });

  it("ignores speech that is not addressed to her", () => {
    // A room is full of talking. Anchoring at the start is what keeps this from firing on all of it.
    for (const t of ["what did jev say about that", "I was telling jeff about it", "the jev model is a classifier", "", "   ", "turn the volume down"]) {
      expect(matchWake(t), t).toBeNull();
    }
  });

  it("names itself to the recogniser, so the engine is told before it has to hear", () => {
    expect(WAKE_KEYWORDS).toContain("Jev");
    expect(WAKE_KEYWORDS).toContain("Hey Jev");
  });
});

describe("the wake state machine", () => {
  const wake = (window = WAKE_WINDOW_MS) => {
    let now = 1_000_000;
    return { w: new Wake(() => now, window), tick: (ms: number) => (now += ms) };
  };

  it("answers a bare 'hey jev' and then listens for the command", () => {
    const { w } = wake();
    expect(w.hear("hey jev")).toEqual({ kind: "answer" });
    expect(w.armed).toBe(true);
    expect(w.hear("open spotify")).toEqual({ kind: "command", text: "open spotify" });
  });

  it("runs a one-breath command without answering first", () => {
    const { w } = wake();
    expect(w.hear("hey jev open spotify")).toEqual({ kind: "command", text: "open spotify" });
    expect(w.armed).toBe(false);
  });

  it("stops listening once the window has passed", () => {
    const { w, tick } = wake();
    w.hear("hey jev");
    tick(WAKE_WINDOW_MS + 1);
    expect(w.armed).toBe(false);
    expect(w.hear("open spotify")).toEqual({ kind: "ignore" });
  });

  it("obeys exactly one command per wake", () => {
    // Without this, a room that keeps talking keeps being obeyed — the failure mode that makes an
    // always-listening assistant unusable.
    const { w } = wake();
    w.hear("hey jev");
    expect(w.hear("open spotify").kind).toBe("command");
    expect(w.hear("and then delete everything")).toEqual({ kind: "ignore" });
  });

  it("ignores the room entirely when it was never woken", () => {
    const { w } = wake();
    for (const t of ["so anyway I told him", "did you see the game", "open spotify"]) expect(w.hear(t)).toEqual({ kind: "ignore" });
  });

  it("re-arms on a second wake", () => {
    const { w, tick } = wake();
    w.hear("hey jev");
    tick(WAKE_WINDOW_MS + 1);
    expect(w.hear("hey jev")).toEqual({ kind: "answer" });
    expect(w.armed).toBe(true);
  });
});

describe("hearing the name in a room that is already talking", () => {
  it("wakes when the greeting lands mid-phrase, and takes only what follows it", () => {
    // Apple's phrase boundary is its own ~700ms silence recycle. Somebody mid-sentence as the name
    // lands means ONE phrase containing both — and a live run proved the anchored match then never
    // woke her at all. The anchor was testing where Apple cut the audio, not whether she was called.
    expect(findWake("so the deadline was thursday hey jev open spotify")?.rest).toBe("open spotify");
    expect(findWake("...and he just laughed. Hey Jev, turn the volume down.")?.rest).toBe("turn the volume down");
    expect(findWake("i was saying hey jev")).toEqual({ rest: "", bare: true });
  });

  it("takes the last call, not the first, when the name is said twice", () => {
    expect(findWake("hey jev hey jev open spotify")?.rest).toBe("open spotify");
  });

  it("still refuses a bare mention of her buried in a sentence", () => {
    // The split that keeps this honest: a greeting plus the name is an address anywhere; the bare
    // name is only an address when it leads.
    expect(findWake("i'll ask jev about it later")).toBeNull();
    expect(findWake("tell jev the deadline moved")).toBeNull();
    // ...and the leading forms still work
    expect(findWake("jev, open spotify")?.rest).toBe("open spotify");
  });

  it("strips the wake word out of the accurate transcript, chatter and all", () => {
    // This is the flush path: Scribe was handed the ring, so its text begins before the wake word.
    expect(findWake("So the deadline was Thursday. Hey Jev, open Wikipedia and search for cats")?.rest).toBe("open Wikipedia and search for cats");
  });

  it("acts on the whole phrase when there is no wake word but she is armed", () => {
    let t = 0;
    const wake = new Wake(() => t);
    expect(wake.hear("hey jev").kind).toBe("answer");
    t = 1000;
    expect(wake.hear("so the deadline was thursday")).toEqual({ kind: "command", text: "so the deadline was thursday" });
  });
});

describe("everyday phrases that must not wake her", () => {
  // A false wake is not harmless any more: it runs a command with a voice attached, and may hand it
  // to Hermes. Matching the greeting anywhere in a phrase bought the real-room case (see above) and
  // these are the phrases that pay for it.
  const quiet = [
    "and hey, dev ops is down again",
    "ok give me a second",
    "hey can you send me that link",
    "i'll ask jev about it later",
    "tell jev the deadline moved",
    "okay so the next thing is the invoice",
    "hi there, thanks for joining",
    "yo what time is the standup",
    "hello everyone, let's get started",
    "he said okay, javelin throw, of all things",
  ];

  it("stays asleep through an ordinary office conversation", () => {
    for (const t of quiet) expect(findWake(t), t).toBeNull();
  });

  it("still wakes for every way the name is actually said to her", () => {
    for (const t of ["hey jev open spotify", "Hey Jeff, turn the volume down", "ok jev what's on my calendar", "so anyway — hey jev, mute"]) {
      expect(findWake(t), t).not.toBeNull();
    }
  });
});

describe("taking her own answer back out", () => {
  it("removes the line she just said from the front of the command", () => {
    // The microphone is open while she answers, and the buffer keeps that moment on purpose — so
    // "Yes?" can be at the front of Scribe's transcript. Echo cancellation compares against
    // Chromium's own output and the voice plays from another process, so this does not rely on it.
    expect(stripSpoken("Yes? Turn Spotify down.", "Yes?")).toBe("Turn Spotify down.");
    expect(stripSpoken("Mm-hm? open spotify", "[cheerful] Mm-hm?")).toBe("open spotify");
    expect(stripSpoken("I'm listening. what's the weather", "I'm listening.")).toBe("what's the weather");
  });

  it("leaves the command alone when she was not heard at all", () => {
    // The normal case: echo cancellation did its job, or she never spoke.
    expect(stripSpoken("turn Spotify down", "Yes?")).toBe("turn Spotify down");
    expect(stripSpoken("yes please do that", "Yes?")).toBe("please do that");
  });

  it("never eats the whole command", () => {
    expect(stripSpoken("Yes?", "Yes?")).toBe("");
  });
});
