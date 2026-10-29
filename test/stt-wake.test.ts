import { describe, expect, it, vi } from "vitest";
import type { SttServerMessage } from "../core/protocol.js";
import { QUIET_MS, RING_SECONDS, WakeSession } from "../server/stt/wake-relay.js";
import type { SttEvent, SttProvider, SttStart, SttStream } from "../server/stt/types.js";

/** Records what it was opened with and what audio it got, and lets the test drive its events. */
class FakeProvider implements SttProvider {
  /** When set, finish() does not close the stream — a provider that is slow to commit, which is what
   *  leaves the relay's 1.5s flush guard as the only thing ending the phrase. */
  slowCommit = false;
  opens: SttStart[] = [];
  audio: Uint8Array[] = [];
  finished = 0;
  closed = 0;
  emit: ((ev: SttEvent) => void) | null = null;
  constructor(readonly name: string) {}
  open(start: SttStart, onEvent: (ev: SttEvent) => void): SttStream {
    this.opens.push(start);
    this.emit = onEvent;
    return {
      send: (a) => this.audio.push(a),
      // A real provider commits on finish and the socket then closes, which is what the relay waits
      // for before it emits the utterance (it has a 1.5s guard for providers that don't).
      finish: () => {
        this.finished++;
        if (!this.slowCommit) setTimeout(() => onEvent({ type: "closed" }), 0);
      },
      close: () => this.closed++,
    };
  }
  get bytes() {
    return this.audio.reduce((n, c) => n + c.byteLength, 0);
  }
}

function setup(over: { deaf?: () => boolean; noTranscriber?: boolean } = {}) {
  const listener = new FakeProvider("apple");
  const transcriber = new FakeProvider("elevenlabs");
  const sent: SttServerMessage[] = [];
  const session = new WakeSession(
    {
      listener,
      transcriber: over.noTranscriber ? null : transcriber,
      send: (m) => sent.push(m),
      ...(over.deaf ? { deaf: over.deaf } : {}),
      quietMs: 30,
    },
    { sampleRate: 16000 },
  );
  session.open();
  const heard = (text: string, final = true) => listener.emit!({ type: "transcript", text, final, speechFinal: false });
  const said = (text: string, final = true) => transcriber.emit!({ type: "transcript", text, final, speechFinal: false });
  const frame = (byte: number) => session.send(new Uint8Array(3200).fill(byte));
  const utterances = () => sent.filter((m) => m.type === "utterance").map((m) => (m as { text: string }).text);
  return { listener, transcriber, sent, session, heard, said, frame, utterances };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

describe("wake mode: which engine does what", () => {
  it("opens only the free on-device listener until someone says her name", () => {
    // The whole cost argument: a room nobody is talking to must not reach a metered engine.
    const { listener, transcriber, frame, heard } = setup();
    expect(listener.opens).toHaveLength(1);
    frame(1);
    heard("so anyway I told him about the thing");
    frame(2);
    expect(transcriber.opens).toHaveLength(0);
    expect(transcriber.bytes).toBe(0);
  });

  it("hands the accurate engine the audio from BEFORE the wake word", async () => {
    // "Hey Jev, turn Spotify down" is one breath: by the time the wake word is recognised its
    // command audio has already gone past. Without the ring, that form cannot work at all.
    const { transcriber, frame, heard, said, utterances } = setup();
    frame(7);
    frame(7);
    heard("hey jev turn spotify down");
    expect(transcriber.opens).toHaveLength(1);
    expect(transcriber.bytes).toBe(6400); // both buffered frames, replayed
    said("Hey Jev, turn Spotify down");
    await settle();
    // and Scribe's copy of the wake word is stripped from the result
    expect(utterances()).toEqual(["turn Spotify down"]);
  });

  it("answers a bare 'hey jev' and transcribes what comes next", async () => {
    const { sent, transcriber, heard, said, utterances } = setup();
    heard("hey jev");
    expect(sent.some((m) => m.type === "wake")).toBe(true);
    expect(transcriber.opens).toHaveLength(0); // nothing billed just to say "Yes?"

    heard("open spotify");
    expect(transcriber.opens).toHaveLength(1);
    said("open Spotify");
    await settle();
    expect(utterances()).toEqual(["open Spotify"]);
  });

  it("stops billing the moment the command ends", async () => {
    const { transcriber, heard, said } = setup();
    heard("hey jev open spotify");
    said("open Spotify");
    await settle();
    expect(transcriber.closed).toBe(1);
    expect(transcriber.finished).toBe(1);
  });
});

describe("wake mode: where the phrase ends", () => {
  it("does not cut a command at the first pause", async () => {
    // Apple recycles its recognition request every ~700ms of silence — the M5.5 bug that split
    // dictation mid-sentence. A single `final` must not end the phrase; only the quiet timer does.
    const { transcriber, heard, said, utterances } = setup();
    heard("hey jev");
    heard("open spotify");
    said("open Spotify", false);
    heard("and play the playlist"); // listener keeps ticking: resets the quiet timer
    await settle(20);
    expect(transcriber.finished).toBe(0);
    said("open Spotify and play the playlist");
    await settle();
    expect(utterances()).toEqual(["open Spotify and play the playlist"]);
  });

  it("keeps feeding the free listener while the command is transcribed", async () => {
    // Apple IS the voice-activity detector for the command: only its events reset the quiet timer.
    // Feeding just the transcriber leaves that timer armed once, at the wake word — and a live run
    // then cut "open wikipedia <pause> and search for the tallest building" off at "tallest-".
    // The earlier pause test could not catch it, because it called heard() by hand.
    const { listener, transcriber, frame, heard } = setup();
    heard("hey jev open wikipedia");
    const before = listener.bytes;
    frame(9);
    frame(9);
    expect(listener.bytes).toBe(before + 6400); // still hearing everything
    expect(transcriber.bytes).toBeGreaterThan(0); // and so is the one doing the transcribing
  });

  it("ends the phrase once the room goes quiet", async () => {
    const { transcriber, heard } = setup();
    heard("hey jev open spotify");
    expect(transcriber.finished).toBe(0);
    await settle();
    expect(transcriber.finished).toBe(1);
  });

  it("commits the command once, however long the listener keeps talking", async () => {
    // Apple is fed through the whole command now, so its events keep arriving after the phrase has
    // been committed. Without a guard they re-arm the quiet timer and call finish() again on a stream
    // that is already closing.
    const { transcriber, heard } = setup();
    transcriber.slowCommit = true; // the stream stays open until the relay's own flush guard
    heard("hey jev open spotify");
    await settle(60); // the quiet timer fires and the phrase is committed
    expect(transcriber.finished).toBe(1);
    // Apple is still running, and keeps delivering while Scribe commits
    heard("some other conversation");
    await settle(60);
    heard("and some more of it");
    await settle(60);
    expect(transcriber.finished).toBe(1); // committed once, not once per thing the room says
  });

  it("says nothing at all when the command turned out to be empty", async () => {
    const { heard, said, utterances, sent } = setup();
    heard("hey jev open spotify");
    said("   ");
    await settle();
    expect(utterances()).toEqual([]);
    expect(sent.filter((m) => m.type === "utterance")).toEqual([]);
  });
});

describe("wake mode: what it refuses to hear", () => {
  it("sends nothing she is saying to either engine", () => {
    // The microphone is always open in wake mode, so every reply is audible to it. Without this she
    // transcribes her own answer, decides it was a command, and answers herself. The gate stops the
    // audio reaching an ENGINE — it deliberately does not stop it reaching the buffer, or a command
    // spoken over her would lose its first half (see the talk-over test below).
    let speaking = false;
    const { listener, frame, heard, transcriber } = setup({ deaf: () => speaking });
    frame(1);
    expect(listener.bytes).toBe(3200);
    speaking = true;
    frame(2);
    frame(3);
    expect(listener.bytes).toBe(3200); // nothing of her own reply was transcribed
    speaking = false;
    frame(4);
    expect(listener.bytes).toBe(6400);
    heard("hey jev mute");
    // ...and the metered engine was never opened until she was actually addressed
    expect(transcriber.opens).toHaveLength(1);
  });

  it("does not lose the words spoken over her own answer", async () => {
    // A live run of "Hey Jev" → "Yes?" → "turn Spotify down" came back as just "down": the gate
    // dropped the frames while she was answering, and "turn Spotify" was in them. The gate still
    // keeps her voice away from both engines — but the buffer keeps everything, so the command can be
    // recovered from it the moment the engine opens.
    let speaking = false;
    const { listener, transcriber, frame, heard, said, utterances } = setup({ deaf: () => speaking });
    heard("hey jev");
    speaking = true; // "Yes?" is playing, and the user talks straight over it
    frame(1);
    frame(2);
    frame(3);
    expect(listener.bytes).toBe(0); // she is not transcribing her own answer...
    speaking = false;
    frame(4);
    heard("down"); // ...so Apple only caught the tail of what he said
    expect(transcriber.bytes).toBe(4 * 3200); // but the buffer kept all of it
    said("turn Spotify down");
    await settle();
    await expect.poll(utterances, { timeout: 2000 }).toEqual(["turn Spotify down"]);
  });

  it("obeys one command per wake, not a whole conversation", async () => {
    const { heard, said, utterances, transcriber } = setup();
    heard("hey jev");
    heard("open spotify");
    said("open Spotify");
    await settle();
    expect(utterances()).toEqual(["open Spotify"]);
    heard("and delete everything");
    expect(transcriber.opens).toHaveLength(1); // not woken again
  });

  it("falls back to the listener when no accurate engine is configured", async () => {
    const { listener, heard, utterances } = setup({ noTranscriber: true });
    heard("hey jev open spotify");
    expect(listener.opens).toHaveLength(2); // a second stream from the same provider
    await settle();
    expect(utterances().length).toBeLessThanOrEqual(1);
  });

  it("closes both engines when the socket goes away", () => {
    const { listener, transcriber, heard, session } = setup();
    heard("hey jev open spotify");
    session.close();
    expect(listener.closed).toBe(1);
    expect(transcriber.closed).toBe(1);
    // and nothing more is accepted
    session.send(new Uint8Array(10));
    expect(listener.bytes + transcriber.bytes).toBeLessThan(10 + 3200);
  });
});

describe("wake mode: the constants that bound the cost", () => {
  it("keeps enough audio for a one-breath command, and no more", () => {
    expect(RING_SECONDS).toBeGreaterThanOrEqual(5);
    expect(RING_SECONDS).toBeLessThanOrEqual(15);
  });

  it("waits longer than the recogniser's own recycle before calling it silence", () => {
    // The helper recycles at ~700ms; anything at or below that re-creates the M5.5 truncation bug.
    expect(QUIET_MS).toBeGreaterThan(1000);
  });
});
