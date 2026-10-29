/** Opt-in actual renderer -> LiveKit -> GPT-Live with generated speech, no physical microphone. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { RoomServiceClient } from "livekit-server-sdk";
import { parseEnv } from "../server/env.ts";
import { createAssistantRuntime } from "../server/assistant/runtime.ts";
import { createCompanion } from "../server/companion.ts";
import { HeuristicDecider } from "../core/decide.ts";
import { startVoiceProcess } from "../server/assistant/voice-process.ts";
if (process.env.JEV_LIVE_VOICE_SMOKE !== "1") throw new Error("Set JEV_LIVE_VOICE_SMOKE=1 to test synthetic renderer speech with your OpenAI/LiveKit accounts.");
const root = fileURLToPath(new URL("..", import.meta.url));
const keys = parseEnv(readFileSync(path.join(homedir(), ".jev-assistant/.env"), "utf8"));
const home = mkdtempSync(path.join(tmpdir(), "jarvis-renderer-voice-"));
const env = { JEV_HOME: home, JEV_TOKEN: randomBytes(32).toString("hex"), OPENAI_API_KEY: keys.OPENAI_API_KEY, LIVEKIT_URL: keys.LIVEKIT_URL, LIVEKIT_API_KEY: keys.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: keys.LIVEKIT_API_SECRET };
const runtime = createAssistantRuntime({ env, hands: { mac: null, chrome: null, computer: null }, chromeReady: () => false, computerReady: () => false });
const companion = createCompanion({ assistant: runtime, token: env.JEV_TOKEN, decider: new HeuristicDecider(), clientDir: path.join(root, "dist/client") });
const rooms = new RoomServiceClient(env.LIVEKIT_URL.replace(/^ws/, "http"), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { requestTimeout: 4 });
const wait = async (fn, ms = 45000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw Error("Renderer voice condition timed out"); await new Promise(r => setTimeout(r, 300)); } };
let worker, browser, roomName;
try {
  execFileSync("say", ["-o", `${home}/prompt.aiff`, "Hello Jarvis. What is five plus seven? Say the answer out loud."]);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", `${home}/prompt.aiff`, "-af", "adelay=3000:all=1", "-ar", "48000", "-ac", "1", `${home}/prompt.wav`]);
  const port = await companion.listen(0), base = `http://127.0.0.1:${port}`;
  worker = startVoiceProcess(root, base, runtime, env); await wait(() => runtime.status().voiceWorker === "running");
  browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${home}/prompt.wav%noloop`, "--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  page.on("response", async response => { if (response.url().endsWith("/assistant/voice/token") && response.ok()) roomName = (await response.json()).room; });
  await page.goto(base); await page.getByRole("button", { name: "Talk to Jarvis", exact: true }).click();
  await page.getByRole("button", { name: "End conversation", exact: true }).or(page.locator(".assistant-error")).waitFor({ timeout: 60000 });
  if (await page.locator(".assistant-error").count()) throw new Error(`Voice UI reported: ${(await page.locator(".assistant-error").innerText()).slice(0, 500)}`);
  await page.getByText("Microphone is receiving sound.", { exact: true }).waitFor({ timeout: 20000 });
  await wait(async () => /(?:twelve|12)/i.test(await page.locator('.voice-transcript').innerText()), 45000);
  assert.ok(await page.locator('.voice-transcript').innerText());
  // Verify that return audio arrived and progressed through the renderer's playback element.
  await wait(() => page.locator('audio').evaluateAll(elements => elements.some(el => el.currentTime > 0.1)), 15000);
  await page.getByRole("button", { name: "End conversation", exact: true }).click();
  await page.getByRole("button", { name: "Talk to Jarvis", exact: true }).waitFor();
  await wait(async () => !(await rooms.listRooms()).some(r => r.name === roomName), 15000);
  console.log("PASS: actual renderer captured generated speech, showed microphone input, received a GPT-Live answer and played return audio; voice room deletion confirmed. No physical microphone conversation was tested.");
} finally { await browser?.close(); worker?.stop(); await companion.close(); rmSync(home, { recursive: true, force: true }); }
await new Promise(r => setTimeout(r, 4500)); process.exit(0);
