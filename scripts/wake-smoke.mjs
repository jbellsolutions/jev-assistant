/** Live check for wake mode: real Apple helper, real ElevenLabs Scribe, real audio.
 *
 *  Speaks phrases with `say`, converts them to the exact frames the panel sends (16 kHz mono
 *  pcm_s16le, 100 ms each), streams them at wall-clock speed into a real /ws/stt socket, and prints
 *  every message the relay sends back.
 *
 *  It exists because the unit tests run against fakes: what a green suite cannot tell you is whether
 *  Apple actually hears "Hey Jev" out of a speaker, whether the ring buffer really carries the
 *  one-breath command to Scribe, and whether an idle room reaches the metered engine at all.
 *
 *    node --import tsx scripts/wake-smoke.mjs one-breath|two-turn|idle
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { loadEnvFile } from "../server/env.js";
import { createCompanion } from "../server/companion.js";
import { createDecider } from "../core/decide.js";
import { selectSttProvider, selectWakeListener, describeWake } from "../server/stt/select.js";
import { GatedSpeaker, SpeechGate } from "../server/speak/gate.js";

const FRAME = 3200; // 100 ms of 16 kHz mono s16le
const dir = mkdtempSync(path.join(tmpdir(), "jev-wake-"));

/** One phrase as PCM frames, plus however many frames of silence follow it. */
const durations = [];
function speak(text, silenceMs = 0) {
  const aiff = path.join(dir, `${Buffer.from(text).toString("hex").slice(0, 12)}.aiff`);
  const raw = `${aiff}.raw`;
  execFileSync("say", ["-o", aiff, text]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "quiet", "-i", aiff, "-ar", "16000", "-ac", "1", "-f", "s16le", raw]);
  const pcm = readFileSync(raw);
  const quiet = Buffer.alloc(Math.round((silenceMs / 1000) * 32000));
  durations.push({ speech: pcm.length / 32000, silence: silenceMs / 1000 });
  return Buffer.concat([pcm, quiet]);
}

const scripts = {
  // The form the ring buffer exists for: by the time Apple has the wake word, the command is past.
  "one-breath": () => [speak("Hey Jev, turn Spotify down", 2500)],
  // The form that needs no buffer: name, answer, then the command.
  "two-turn": () => [speak("Hey Jev", 1500), speak("open Spotify", 2500)],
  // Bare name, a natural pause, then the command — with a voice attached. She answers "Yes?", which
  // makes the gate deaf, and the command is spoken straight into that deaf window.
  "answer-race": () => [speak("Hey Jev", 800), speak("turn Spotify down", 2500)],
  // A command with a natural pause in it. The gap is long enough for Apple to recycle and emit a
  // final (~700ms) but shorter than QUIET_MS, so nothing should end the phrase there.
  "long-command": () => [speak("Hey Jev, open wikipedia", 900), speak("and search for the tallest building in the world", 2500)],
  // Someone was already talking when the name landed. The ring replays that chatter into Scribe,
  // so the wake word arrives in the MIDDLE of Scribe's transcript, not at the start of it.
  chatter: () => [speak("so the deadline was Thursday", 300), speak("Hey Jev, open Spotify", 2500)],
  // Nothing addressed to her. Scribe must never open, so this hour costs nothing.
  idle: () => [speak("so anyway I told him the deadline was Thursday and he just laughed", 2000)],
};

const which = process.argv[2] ?? "one-breath";
if (!scripts[which]) {
  console.error(`unknown script: ${which} (have ${Object.keys(scripts).join(", ")})`);
  process.exit(2);
}

loadEnvFile(path.join(import.meta.dirname, "..", ".env"));
const listener = selectWakeListener();
const transcriber = selectSttProvider();
console.log(describeWake(listener, transcriber));
if (!listener) process.exit(1);

// Count what each engine is actually asked to do — the cost claim, measured rather than asserted.
const counted = (p, label) =>
  p && {
    name: p.name,
    opens: 0,
    bytes: 0,
    open(start, onEvent) {
      this.opens++;
      console.log(`  [${label}] stream opened`);
      const s = p.open(start, onEvent);
      return {
        send: (a) => {
          this.bytes += a.byteLength;
          s.send(a);
        },
        finish: () => s.finish(),
        close: () => s.close(),
      };
    },
  };
const ear = counted(listener, "apple");
const mouth = counted(transcriber, "scribe");

// No token: a loopback smoke harness, and the socket auth is not what is under test here.
// A voice that plays nothing but holds the gate exactly as long as a real reply would, so the
// self-hearing gate is under test without needing a Fish key or a speaker in the room.
const gate = new SpeechGate();
const said = [];
const HOLD_MS = Number(process.env.WAKE_SMOKE_HOLD_MS ?? 900);
const speaker = new GatedSpeaker(
  {
    maxChars: 600,
    async speak(text) {
      said.push(text);
      console.log(`  [voice] "${text}" (${HOLD_MS}ms)`);
      await new Promise((r) => setTimeout(r, HOLD_MS));
    },
    stop() {},
  },
  gate,
);
const withVoice = which === "answer-race";
const companion = createCompanion({ decider: createDecider(), stt: mouth, sttListener: ear, ...(withVoice ? { speaker, gate } : {}) });
const port = await companion.listen(0);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`);
const got = [];
let speechEndedAt = 0;
ws.on("message", (d) => {
  const m = JSON.parse(String(d));
  if (m.type === "utterance" && speechEndedAt) console.log(`  (${Date.now() - speechEndedAt}ms after the last word was spoken — quiet timer + commit)`);
  if (m.type === "transcript" && !m.text) return;
  got.push(m);
  console.log(`  <- ${JSON.stringify(m)}`);
});
await new Promise((r) => ws.once("open", r));
ws.send(JSON.stringify({ type: "start", sampleRate: 16000, encoding: "pcm_s16le", channels: 1, lang: "en-US", keywords: ["Jev"], mode: "wake" }));
await new Promise((r) => setTimeout(r, 400));

const t0 = Date.now();
const segments = scripts[which]();
for (const [n, audio] of segments.entries()) {
  const speechFrames = Math.round((durations[n]?.speech ?? 0) * 10);
  for (let i = 0; i < audio.length; i += FRAME) {
    ws.send(audio.subarray(i, i + FRAME));
    // the moment the last WORD leaves, which is what the end-of-phrase delay is measured from
    if (n === segments.length - 1 && i / FRAME === speechFrames) speechEndedAt = Date.now();
    await new Promise((r) => setTimeout(r, 100)); // real time, as the microphone would
  }
}
if (!speechEndedAt) speechEndedAt = Date.now();
await new Promise((r) => setTimeout(r, 6000)); // let the quiet timer and the flush land

console.log(`\n${which}: ${((Date.now() - t0) / 1000).toFixed(1)}s of audio`);
console.log(`  apple:  ${ear.opens} stream(s), ${(ear.bytes / 32000).toFixed(1)}s of audio`);
console.log(`  scribe: ${mouth.opens} stream(s), ${(mouth.bytes / 32000).toFixed(1)}s of audio  <- what gets billed`);
const utterances = got.filter((m) => m.type === "utterance").map((m) => m.text);
console.log(`  woke:   ${got.filter((m) => m.type === "wake").length}${withVoice ? ` (said ${JSON.stringify(said)})` : ""}`);
console.log(`  heard:  ${utterances.length ? utterances.map((t) => JSON.stringify(t)).join(", ") : "(nothing — correct for idle)"}`);
ws.close();
await companion.close();
process.exit(0);
