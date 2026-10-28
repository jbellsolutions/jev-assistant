/** Opt-in synthetic microphone -> real LiveKit -> real Mac worker. Opens/reads Slack; never sends. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Room, RoomEvent, AudioStream, AudioSource, AudioFrame, LocalAudioTrack, TrackKind, TrackSource, TrackPublishOptions } from "@livekit/rtc-node";
import { RoomServiceClient } from "livekit-server-sdk";
import { parseEnv } from "../server/env.ts";
import { selectMac } from "../server/executors/mac.ts";
import { MacComputer } from "../server/computer.ts";
import { createAssistantRuntime } from "../server/assistant/runtime.ts";
import { createCompanion } from "../server/companion.ts";
import { HeuristicDecider } from "../core/decide.ts";
import { startVoiceProcess } from "../server/assistant/voice-process.ts";
if (process.env.JEV_LIVE_MAC_SMOKE !== "1") throw new Error("Set JEV_LIVE_MAC_SMOKE=1 to use your OpenAI/LiveKit accounts for this synthetic voice test.");
const root = fileURLToPath(new URL("..", import.meta.url));
const keys = parseEnv(readFileSync(path.join(homedir(), ".jev-assistant/.env"), "utf8"));
const home = mkdtempSync(path.join(tmpdir(), "jarvis-mac-voice-"));
const env = { JEV_HOME: home, JEV_TOKEN: randomBytes(32).toString("hex"), OPENAI_API_KEY: keys.OPENAI_API_KEY, LIVEKIT_URL: keys.LIVEKIT_URL, LIVEKIT_API_KEY: keys.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: keys.LIVEKIT_API_SECRET, JEV_LIVE_VOICE: keys.JEV_LIVE_VOICE };
const mac = selectMac(); if (!mac) throw new Error("Mac control unavailable"); await mac.start(); assert.ok(mac.ready);
const runtime = createAssistantRuntime({ env, hands: { mac, chrome: null, computer: new MacComputer() }, chromeReady: () => false, computerReady: () => mac.ready });
const companion = createCompanion({ assistant: runtime, token: env.JEV_TOKEN, decider: new HeuristicDecider() });
const rooms = new RoomServiceClient(env.LIVEKIT_URL.replace(/^ws/, "http"), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { requestTimeout: 4 });
let worker, room, source, info, reader, reading, pump; let pumping = false, pcmQueue = null, offset = 0, heardAudio = false;
const wait = async (fn, ms = 45000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() >= end) throw new Error("Synthetic Mac voice check timed out"); await new Promise((r) => setTimeout(r, 300)); } };
let call;
try {
  execFileSync("say", ["-o", `${home}/prompt.aiff`, "On my Mac at home, open Slack, then inspect its window and tell me whether you can see it. Do not send any messages."]);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", `${home}/prompt.aiff`, "-f", "s16le", "-ar", "24000", "-ac", "1", `${home}/prompt.pcm`]);
  const pcm = readFileSync(`${home}/prompt.pcm`), samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  const port = await companion.listen(0), base = `http://127.0.0.1:${port}`;
  call = async (route, body) => { const r = await fetch(`${base}/assistant${route}`, { method: "POST", headers: { authorization: `Bearer ${env.JEV_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); const data = await r.json(); if (!r.ok) throw Error(data.error || "Voice request failed"); return data; };
  worker = startVoiceProcess(root, base, runtime, env); await wait(() => runtime.status().voiceWorker === "running");
  info = await call("/voice/token", { target: "local" }); room = new Room();
  room.on(RoomEvent.TrackSubscribed, (track) => { if (track.kind !== TrackKind.KIND_AUDIO) return; reader = new AudioStream(track, 24000, 1).getReader(); reading = (async () => { for (;;) { const { done, value } = await reader.read(); if (done) break; if (value.data.some((n) => Math.abs(n) > 100)) heardAudio = true; } })().catch(() => {}); });
  await room.connect(info.url, info.token, { autoSubscribe: true });
  await wait(async () => { const c = await call("/voice/connection", { room: info.room }); if (c.state === "failed") throw Error(`Voice model failed: ${c.failure}`); return c.state === "ready"; });
  source = new AudioSource(24000, 1); const track = LocalAudioTrack.createAudioTrack("synthetic-mac-request", source); const options = new TrackPublishOptions(); options.source = TrackSource.SOURCE_MICROPHONE; await room.localParticipant.publishTrack(track, options);
  pumping = true; pcmQueue = samples;
  pump = (async () => { let next = Date.now(); while (pumping) { const data = new Int16Array(480); if (pcmQueue) { data.set(pcmQueue.subarray(offset, Math.min(offset + 480, pcmQueue.length))); offset += 480; if (offset >= pcmQueue.length) pcmQueue = null; } await source.captureFrame(new AudioFrame(data, 24000, 1, 480)); next += 20; await new Promise((r) => setTimeout(r, Math.max(0, next - Date.now()))); } })().catch(() => {});
  await wait(async () => {
    const tasks = runtime.queue.list();
    for (const t of tasks) if (t.approval) { await runtime.queue.approve(t.id, "deny", t.approval.requestId); throw Error("Unexpected write approval during a read-only voice test"); }
    return tasks.some((t) => t.target === "local" && t.status === "completed" && t.history.some((h) => h.text.includes("Using mac_read")));
  }, 150000);
  assert.equal(mac.window?.app_name, "Slack"); await wait(() => heardAudio, 15000);
  console.log("PASS: synthetic speech through LiveKit delegated to the real Mac worker, inspected Slack and returned non-silent voice audio. No physical microphone was used and no Slack message was sent.");
} finally {
  try {
    pumping = false; await pump; await reader?.cancel(); await reading; await source?.close(); await room?.disconnect();
    if (info) await call("/voice/end", { room: info.room });
    worker?.stop();
    if (info) await wait(async () => !(await rooms.listRooms()).some((r) => r.name === info.room), 15000);
    console.log("PASS: test voice room shutdown independently confirmed.");
  } finally { worker?.stop(); await companion.close(); rmSync(home, { recursive: true, force: true }); }
}
// rtc-node's native FFI keeps handles alive after all rooms close. This opt-in CLI has no more work.
await new Promise((resolve) => setTimeout(resolve, 4500));
process.exit(0);
