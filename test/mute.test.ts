/** the user's mute: "turn off the speech back to me". Muted means nothing is spoken — answers, the
 *  timer alarm, the "yes?" — while everything still shows in the panel. */
import { describe, expect, it } from "vitest";
import { HeuristicDecider } from "../core/decide.js";
import type { ServerMessage } from "../core/protocol.js";
import { voiceMuteCommand } from "../core/route.js";
import { Session } from "../core/session.js";
import { TimerStore } from "../core/timers.js";
import { GatedSpeaker, MuteSwitch, SpeechGate } from "../server/speak/gate.js";
import { FakeBrain, tick } from "./helpers/fake-brain.js";
import { FakeExecutor } from "./helpers/fake-executor.js";

function voice(muted = false) {
  const spoken: string[] = [];
  let stopped = 0;
  const gate = new SpeechGate();
  const mute = new MuteSwitch(muted);
  const speaker = new GatedSpeaker({ speak: async (t: string) => void spoken.push(t), stop: () => void stopped++, maxChars: 600 }, gate, mute);
  return { spoken, gate, mute, speaker, stopped: () => stopped };
}

describe("the mute switch", () => {
  it("says nothing while muted, and leaves the microphone open", async () => {
    const v = voice(true);
    await v.speaker.speak("Hello the user.");
    expect(v.spoken).toEqual([]);
    expect(v.gate.deaf()).toBe(false); // nothing played, so nothing to be deaf to
    v.mute.set(false);
    await v.speaker.speak("Back.");
    expect(v.spoken).toEqual(["Back."]);
  });

  it("stops the sentence she is in the middle of", () => {
    const v = voice();
    v.mute.set(true);
    expect(v.stopped()).toBe(1);
    v.mute.set(true); // no change, no second stop
    v.mute.set(false);
    expect(v.stopped()).toBe(1);
  });
});

describe("mute by voice", () => {
  it("is her voice, never the Mac's mute", () => {
    expect(voiceMuteCommand("mute yourself")).toBe(true);
    expect(voiceMuteCommand("Jev, mute yourself please.")).toBe(true);
    expect(voiceMuteCommand("voice off")).toBe(true);
    expect(voiceMuteCommand("stop talking back")).toBe(true);
    expect(voiceMuteCommand("unmute yourself")).toBe(false);
    expect(voiceMuteCommand("voice on")).toBe(false);
    expect(voiceMuteCommand("talk to me again")).toBe(false);
    // Bare "mute" is a volume control (core/controls.ts) and stays one.
    expect(voiceMuteCommand("mute")).toBeNull();
    expect(voiceMuteCommand("unmute")).toBeNull();
    expect(voiceMuteCommand("mute spotify")).toBeNull();
  });

  it("flips the host's switch and never reaches the brain", async () => {
    const brain = new FakeBrain();
    const flips: boolean[] = [];
    const session = new Session("fake", { executor: new FakeExecutor(), decider: new HeuristicDecider(), brain, onMute: (m) => flips.push(m) });
    const r = await session.command("mute yourself");
    expect(flips).toEqual([true]);
    expect(r.steps[0]!.result?.text).toMatch(/^Muted/);
    await session.command("voice on");
    expect(flips).toEqual([true, false]);
    expect(brain.sent).toEqual([]);
  });
});

describe("muted, every lane is silent", () => {
  it("a brain answer shows but is not said", async () => {
    const v = voice(true);
    const brain = new FakeBrain();
    const messages: ServerMessage[] = [];
    const session = new Session("fake", { executor: new FakeExecutor(), decider: new HeuristicDecider(), brain, speaker: v.speaker });
    session.subscribe((m) => messages.push(m));
    await session.command("what's on my calendar today", { speak: true });
    brain.emit("run_1", { kind: "completed", output: "A dentist at ten." });
    await tick();
    await tick();
    expect(v.spoken).toEqual([]);
    expect(JSON.stringify(messages)).toMatch(/dentist at ten/);
  });

  it("the timer alarm shows but is not said", async () => {
    const v = voice(true);
    let now = 1_000_000;
    const fires: Array<{ at: number; fire: () => void }> = [];
    const messages: ServerMessage[] = [];
    const session = new Session("fake", {
      executor: new FakeExecutor(),
      decider: new HeuristicDecider(),
      speaker: v.speaker,
      timers: new TimerStore(() => now),
      scheduleTimer: (ms, fire) => fires.push({ at: now + ms, fire }),
    });
    session.subscribe((m) => messages.push(m));
    await session.command("set a timer for 1 minute", { speak: true });
    now += 60_000;
    for (const f of fires.splice(0)) f.fire();
    await tick();
    expect(v.spoken).toEqual([]);
    expect(JSON.stringify(messages)).toMatch(/[Tt]ime's up/);
  });
});
