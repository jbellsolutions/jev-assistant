/** One call to give Jev a voice, for both entry points (server/index.ts and app/main.ts).
 *
 *  Exists so the two construction sites — which have drifted apart before — say the same thing in
 *  one line each, and so the gate can never be forgotten: the speaker handed back is already
 *  wrapped, so anything that speaks closes the microphone whether or not it remembers to. */
import type { Speaker } from "../../core/speak.js";
import { GatedSpeaker, MuteSwitch, SpeechGate } from "./gate.js";
import { describeSpeaker, selectSpeaker } from "./select.js";
import { type WarmableSpeaker, describeWarm, warmVoice } from "./warm.js";

export interface Voice {
  /** Gate-wrapped and ready to hand to the companion; null when no voice is configured. */
  speaker: Speaker | null;
  /** The shared audio-playing signal the STT relay consults. */
  gate: SpeechGate;
  /** the user's mute; the speaker checks it on every line. */
  mute: MuteSwitch;
  /** One line for the startup log. */
  description: string;
  /** Pre-render the scripted vocabulary in the background. Never throws, never blocks. */
  warm(log: (line: string) => void): void;
}

export function createVoice(env: NodeJS.ProcessEnv = process.env, gate = new SpeechGate(), mute = new MuteSwitch()): Voice {
  const inner = selectSpeaker(env);
  // Warming is a capability, not a vendor: anything that can say whether a line is cached and put it
  // there gets pre-rendered, and a voice that cannot simply pays synthesis on first use.
  const warmable = inner && typeof (inner as Partial<WarmableSpeaker>).isCached === "function" && typeof (inner as Partial<WarmableSpeaker>).render === "function" ? (inner as unknown as WarmableSpeaker) : null;
  return {
    speaker: inner ? new GatedSpeaker(inner, gate, mute) : null,
    gate,
    mute,
    description: describeSpeaker(inner, env),
    warm(log) {
      if (!warmable) return;
      void warmVoice(warmable).then(
        (r) => log(describeWarm(r)),
        // warmVoice is written not to reject; this is belt-and-braces so a future change cannot
        // turn a cache miss into an unhandled rejection that takes the app down.
        (err: unknown) => log(`voice cache: pre-render gave up (${err instanceof Error ? err.message : String(err)})`),
      );
    },
  };
}
