/** Wake mode: Apple listens for free, Scribe hears the command.
 *
 *  ## Why two engines
 *
 *  Always-on listening and accurate transcription pull in opposite directions. Streaming a room
 *  continuously to ElevenLabs Scribe bills roughly $0.39/hour to listen to silence. But v7/M0 moved
 *  the user OFF Apple's recogniser precisely because its accuracy was the problem — so making the
 *  headline "talk to it from across the room" experience run on Apple would quietly hand him the
 *  engine he rejected.
 *
 *  So the two engines split by job, which is the arrangement the user picked when the tradeoff was
 *  put to him:
 *
 *  - **Apple runs continuously** and only ever has to spot two words. Free, on-device, and nothing
 *    leaves the Mac while the room is empty. Its `contextualStrings` biasing is already wired
 *    (native/jev-speech/main.swift:126), so it is told the name before it has to hear it.
 *  - **Scribe transcribes the command**, fed the ring buffer from before the wake word plus the
 *    live audio after it. Billed for the seconds the user is actually talking: cents a day.
 *
 *  ## Why the buffer is not optional
 *
 *  "Hey Jev, turn Spotify down" is one breath. By the time Apple has recognised the wake word, the
 *  command's audio is already past. Without the ring, only the two-turn form would work.
 *
 *  ## Where the phrase ends
 *
 *  Push-to-talk gets its boundary from the client's explicit `stop`. Wake mode has no stop, and the
 *  relay has no gap timer of its own — so Apple, still running, IS the voice-activity detector: its
 *  `final` events mark silence. A single one is not enough (the helper recycles every ~700ms, which
 *  is the M5.5 bug that split dictation mid-sentence), so a quiet timer is reset on every Apple
 *  event and only its expiry ends the phrase. */
import type { SttMode, SttServerMessage } from "../../core/protocol.js";
import { Wake, findWake, stripSpoken } from "../../core/wake.js";
import { PcmRing, bytesForSeconds } from "./ring.js";
import type { SttEvent, SttProvider, SttStream } from "./types.js";

/** How much audio to keep, so a one-breath command survives the wake word being recognised. */
export const RING_SECONDS = 8;
/** Silence after the last Apple event that ends the command. Comfortably above the helper's own
 *  ~700ms recycle, so a natural mid-sentence pause does not cut the command in half. */
export const QUIET_MS = 1_400;
/** A command cannot run forever; without this a stuck stream bills Scribe until the socket dies.
 *
 *  15s, not 30: Apple hears everything through the command now (it is the voice-activity detector),
 *  so a television or a conversation next to the microphone keeps resetting the quiet timer. The cap
 *  is what stops that becoming a minute of billed audio and a command with someone else's words in
 *  it. Measured on this Mac: an ordinary spoken command takes ~2–5s, and the end-of-phrase delay
 *  after the last word is ~2.2s, so 15s leaves a wide margin. */
export const MAX_COMMAND_MS = 15_000;

export interface WakeRelayOptions {
  /** Always-on, free, on-device: the one that spots the wake word. */
  listener: SttProvider;
  /** The accurate one, opened only after a wake. Falls back to the listener when absent. */
  transcriber?: SttProvider | null;
  send(msg: SttServerMessage): void;
  /** True while Jev's own voice is playing (server/speak/gate.ts). */
  deaf?: () => boolean;
  /** Answer a bare "Hey Jev" out loud. Server-side rather than in the panel, because the answer has
   *  to go through the same gate the microphone is checked against: otherwise Apple hears her say
   *  "Yes?", treats it as the next phrase, and she takes her own answer as the command.
   *
   *  Returns the line it said, so the words she is known to have spoken can be taken back out of the
   *  command. The buffer keeps the moment she was talking (a command spoken over her has to survive),
   *  so her answer can otherwise turn up at the front of the accurate transcript. */
  onWake?: () => string | void;
  now?: () => number;
  quietMs?: number;
  maxCommandMs?: number;
}

/** One wake-mode session. The relay owns the socket; this owns the two streams and the boundary. */
export class WakeSession {
  private listener: SttStream | null = null;
  private command: SttStream | null = null;
  private ring: PcmRing;
  private readonly wake: Wake;
  private quiet: ReturnType<typeof setTimeout> | undefined;
  private cap: ReturnType<typeof setTimeout> | undefined;
  private finals: string[] = [];
  /** Set from endCommand until the utterance is out. Apple keeps running through the commit, so
   *  without this its next event re-arms the quiet timer and finish() is called on a stream that is
   *  already committing. */
  private finishing = false;
  /** The last thing Jev said out loud, to be removed from what the microphone heard next. */
  private answered: string | null = null;
  private closed = false;

  constructor(
    private readonly opts: WakeRelayOptions,
    private readonly start: { sampleRate: number; lang?: string | undefined; keywords?: string[] | undefined },
  ) {
    this.ring = new PcmRing(bytesForSeconds(RING_SECONDS, start.sampleRate));
    this.wake = new Wake(opts.now ?? Date.now);
  }

  open(): void {
    this.listener = this.opts.listener.open({ sampleRate: this.start.sampleRate, encoding: "pcm_s16le", channels: 1, lang: this.start.lang, keywords: this.start.keywords }, (ev) => this.onListener(ev));
  }

  /** Audio from the browser. Fed to whichever stream is live, and always to the ring. */
  send(chunk: Uint8Array): void {
    if (this.closed) return;
    // The buffer keeps filling even while she is speaking, and only the live engines are starved.
    //
    // Dropping the frames outright — which is what this did — lost the start of every command spoken
    // over her: a live run of "Hey Jev" → "Yes?" → "turn Spotify down" arrived as "down", because
    // "turn Spotify" landed inside the deaf window. The frames cannot be separated by speaker (one
    // microphone hears both at once), so they are kept: getUserMedia's echo cancellation is what
    // suppresses her own voice in them, and that is the job it exists for.
    this.ring.push(chunk);
    // Still true, and the reason the gate is here at all: nothing she says reaches an engine, so she
    // never transcribes her own reply, never decides it was a command, and is never billed for it.
    if (this.opts.deaf?.()) return;
    // Apple keeps hearing everything, command or no command: it is the voice-activity detector that
    // decides where the phrase ends, and it is free and on-device so there is nothing to save by
    // starving it. Feeding only the transcriber left the quiet timer armed once, at the wake word —
    // so "Hey Jev, open wikipedia <pause> and search for the tallest building" was cut after
    // "tallest-" on a real run. That is the M5.5 truncation bug, through a new door.
    this.listener?.send(chunk);
    if (this.command) this.command.send(chunk);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.quiet);
    clearTimeout(this.cap);
    this.listener?.close();
    this.command?.close();
    this.listener = null;
    this.command = null;
    this.ring.clear();
  }

  private onListener(ev: SttEvent): void {
    if (this.closed) return;
    if (ev.type === "open") return this.opts.send({ type: "ready", provider: `${this.opts.listener.name} (wake)` });
    if (ev.type === "error") return this.opts.send({ type: "error", message: ev.message });
    if (ev.type === "closed") return this.opts.send({ type: "closed" });
    if (ev.type !== "transcript") return;

    // While a command is being transcribed, the listener is only a voice-activity detector: its
    // text is the inaccurate copy of what Scribe is already hearing properly.
    if (this.command) {
      if (!this.finishing) this.bumpQuiet();
      return;
    }
    if (!ev.final) return;

    const heard = this.wake.hear(ev.text);
    if (heard.kind === "ignore") return;
    if (heard.kind === "answer") {
      this.opts.send({ type: "wake" });
      this.answered = this.opts.onWake?.() ?? null;
      return;
    }
    this.beginCommand();
  }

  /** Hand the buffered audio to the accurate engine and start listening for the end of the phrase. */
  private beginCommand(): void {
    const provider = this.opts.transcriber ?? this.opts.listener;
    this.finals = [];
    this.finishing = false;
    this.command = provider.open({ sampleRate: this.start.sampleRate, encoding: "pcm_s16le", channels: 1, lang: this.start.lang, keywords: this.start.keywords }, (ev) => this.onCommand(ev));
    // Everything since before the wake word. Scribe re-transcribes the wake word too, which is
    // fine: findWake strips it from the result, and giving it the lead-in improves the rest.
    for (const chunk of this.ring.drain()) this.command.send(chunk);
    this.bumpQuiet();
    this.cap = setTimeout(() => this.endCommand(), this.opts.maxCommandMs ?? MAX_COMMAND_MS);
  }

  private onCommand(ev: SttEvent): void {
    if (this.closed) return;
    if (ev.type === "error") {
      this.opts.send({ type: "error", message: ev.message });
      return this.endCommand();
    }
    if (ev.type === "closed") return this.flush();
    if (ev.type !== "transcript") return;
    if (ev.final) this.finals.push(ev.text.trim());
    else this.opts.send({ type: "transcript", text: [...this.finals, ev.text].filter(Boolean).join(" "), final: false });
  }

  private bumpQuiet(): void {
    clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.endCommand(), this.opts.quietMs ?? QUIET_MS);
  }

  /** Ask the transcriber to commit what it has; its close() or a guard produces the utterance. */
  private endCommand(): void {
    clearTimeout(this.quiet);
    clearTimeout(this.cap);
    this.quiet = undefined;
    this.cap = undefined;
    const stream = this.command;
    if (!stream || this.finishing) return;
    this.finishing = true;
    stream.finish();
    // The provider may not close promptly; do not leave the user waiting on it.
    setTimeout(() => this.flush(), 1_500);
  }

  private flush(): void {
    if (!this.command) return;
    this.command.close();
    this.command = null;
    this.finishing = false;
    this.ring.clear();

    const joined = this.finals.join(" ").trim();
    this.finals = [];
    // Scribe heard the wake word too, because it was handed the buffer that contained it — and,
    // when somebody was already talking, whatever was said before it as well. Strip back to after
    // the LAST wake word: everything before it was the room, not the command.
    let text = (findWake(joined)?.rest ?? joined).trim();
    // Her own "Yes?" can be at the front of it — the microphone was open while she said it, and
    // relying on the browser's echo cancellation would be relying on it comparing against audio that
    // came out of a different process. She knows what she said, so she takes it back out.
    if (this.answered) text = stripSpoken(text, this.answered);
    this.answered = null;
    this.opts.send({ type: "transcript", text: "", final: false });
    if (text) this.opts.send({ type: "utterance", text });
  }
}

export const isWakeMode = (mode: SttMode | undefined): boolean => mode === "wake";
