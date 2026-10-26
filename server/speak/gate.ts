/** Keeps Jev from hearing herself.
 *
 *  The moment Jev speaks, the microphone — which in wake mode is always open — is listening to the
 *  speaker. Without a gate she transcribes her own reply, decides it is a command, and answers
 *  herself. hey-jev sidesteps this by only recording between bursts; Jev cannot, because wake mode
 *  is continuous.
 *
 *  This lives on the SERVER, beside the relay, deliberately. The obvious design — have the renderer
 *  stop the microphone when it sees a `speaking` message — races: the message and the first audio
 *  frame leave at the same time, and the round trip is exactly the window in which she hears
 *  herself. Both the speaker and server/stt/relay.ts run in the same process, so the relay can
 *  simply drop audio while a playback is open, plus a short tail for the room's echo.
 *
 *  The gate counts overlapping playbacks rather than holding a boolean: a reply interrupted by a
 *  new one would otherwise un-deafen the microphone while audio is still coming out. */

/** How long after the audio stops to keep ignoring the microphone (room echo, speaker decay). */
export const DEAF_TAIL_MS = 300;

export class SpeechGate {
  private open = 0;
  private until = 0;
  private readonly listeners = new Set<(speaking: boolean) => void>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly tailMs = DEAF_TAIL_MS,
  ) {}

  /** Called when audio starts and when the last overlapping playback ends — and ONLY then.
   *
   *  This is what the panel's "she is talking" flag is driven from. Emitting it per utterance instead
   *  has the bug this class exists to prevent: two overlapping lines each report their own ending, so
   *  the first to finish blanks the indicator while the second is still audible — and then Escape
   *  hides the panel instead of shutting her up. It also catches the lines that belong to no command
   *  at all, like the "Yes?" the relay says. */
  onChange(fn: (speaking: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  begin(): void {
    this.open++;
    if (this.open === 1) for (const fn of this.listeners) fn(true);
  }

  end(): void {
    this.open = Math.max(0, this.open - 1);
    if (this.open === 0) {
      this.until = this.now() + this.tailMs;
      for (const fn of this.listeners) fn(false);
    }
  }

  /** True while audio is playing, or within the tail after the last playback ended. */
  deaf(): boolean {
    return this.open > 0 || this.now() < this.until;
  }

  /** For the `speaking` panel indicator, which wants the audio state without the tail. */
  get speaking(): boolean {
    return this.open > 0;
  }
}

import type { Speaker } from "../../core/speak.js";

/** the user's mute. Muted means nothing is spoken — answers, approvals, the wake word's "Yes?",
 *  timers — while everything still shows in the panel. One switch the speaker consults on every
 *  line, so no lane can forget it; listeners persist it and tell open panels. */
export class MuteSwitch {
  private readonly listeners = new Set<(muted: boolean) => void>();

  constructor(private on = false) {}

  get muted(): boolean {
    return this.on;
  }

  set(muted: boolean): void {
    if (muted === this.on) return;
    this.on = muted;
    for (const fn of this.listeners) fn(muted);
  }

  onChange(fn: (muted: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Wraps any Speaker so the gate closes for the whole of every utterance. Kept separate from
 *  FishSpeaker so a future voice gets this for free and cannot forget to do it. Also where mute is
 *  enforced, for the same reason. */
export class GatedSpeaker implements Speaker {
  constructor(
    private readonly inner: Speaker,
    private readonly gate: SpeechGate,
    private readonly mute?: MuteSwitch,
  ) {
    // Muting mid-sentence stops the sentence: "mute" while she is reading a long answer means now.
    mute?.onChange((muted) => {
      if (muted) inner.stop();
    });
  }

  get maxChars(): number | undefined {
    return this.inner.maxChars;
  }

  async speak(text: string, signal?: AbortSignal): Promise<void> {
    if (this.mute?.muted) return;
    this.gate.begin();
    try {
      await this.inner.speak(text, signal);
    } finally {
      this.gate.end();
    }
  }

  /** Forwarded without touching the gate: nothing is played, so the microphone stays open. */
  async prepare(text: string): Promise<void> {
    await this.inner.prepare?.(text);
  }

  stop(): void {
    this.inner.stop();
  }
}
