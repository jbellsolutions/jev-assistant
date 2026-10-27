/** CLI entry: a companion serving the web client (the desktop app is app/main.ts). */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfiguration } from "./configuration.js";
import { createAssistantRuntime } from "./assistant/runtime.js";
import { startVoiceProcess } from "./assistant/voice-process.js";
import { createDecider } from "../core/decide.js";
import { createCompanion } from "./companion.js";
import { selectComputer } from "./computer.js";
import { FrontExecutor } from "./executors/front.js";
import { selectMac } from "./executors/mac.js";
import { SystemBrowser } from "./executors/system-browser.js";
import { RemoteExecutor } from "./executors/remote.js";
import { createBrain } from "./brain/index.js";
import { selectBrowserBox, browserViewUrl } from "./browserbox.js";
import { createVoice } from "./speak/start.js";
import { selectCofounder, wireCofounder } from "./cofounder.js";
import { selectOrgo } from "./orgo.js";
import { startCofounderAccess } from "./mcp-remote.js";
import { lookAtMac } from "./brain/tools.js";
import { MuteSwitch } from "./speak/gate.js";
import { readState } from "./state.js";
import { deviceReader } from "./speak/device.js";
import { describeStt, describeWake, selectSttProvider, selectWakeListener } from "./stt/select.js";

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
loadConfiguration(projectRoot);
const PORT = Number(process.env.PORT ?? process.env.JEV_APP_PORT ?? 3111);

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "client");

const decider = createDecider();
const computer = selectComputer();
const stt = selectSttProvider();
const sttListener = selectWakeListener();
// Before the brain: whether Jev has a voice changes the shape the brain is asked to answer in.
const voice = createVoice(process.env, undefined, new MuteSwitch(readState().muted === true));
console.log(voice.description);
const outputDevice = deviceReader(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "native", "jev-audio-out", "jev-audio-out"));
void outputDevice().then((d) => console.log(`voice device: ${d ?? "unknown (jev-audio-out not built)"}`));
const bridge = new RemoteExecutor({
  onReady: (ready) => {
    console.log(ready ? "Chrome: bridge connected — acting in your Chrome" : "Chrome: bridge disconnected — pages open in your default browser");
    companion.hub.followDefault();
  },
});
const mac = selectMac();
const cofounder = selectCofounder();
const brain = createBrain(process.env, { spoken: !!voice.speaker, hands: { mac, chrome: bridge, chromeBackground: bridge.jevTab(), computer, box: selectBrowserBox(), cofounder, orgo: selectOrgo() } });
const assistant = createAssistantRuntime({ env: process.env, hands: { mac, chrome: bridge, chromeBackground: bridge.jevTab(), computer, cofounder, orgo: selectOrgo() }, chromeReady: () => bridge.ready, computerReady: () => mac?.ready ?? false });
const companion = createCompanion({
  phone: { home: process.env.JEV_HOME!, port: process.env.JEV_PHONE_PORT ? Number(process.env.JEV_PHONE_PORT) : undefined },
  assistant,
  decider,
  token: process.env.JEV_TOKEN,
  clientDir,
  defaultSession: process.env.JEV_DEFAULT_SESSION,
  stt,
  sttListener,
  speaker: voice.speaker,
  voiceDescription: voice.description,
  outputDevice,
  gate: voice.gate,
  cofounder,
  mute: voice.mute,
  brain,
  computer,
  bridge,
  browserView: browserViewUrl(),
});
const system = new SystemBrowser();

const front = mac ? new FrontExecutor({ mac, chrome: bridge, fallback: system }) : null;

let cofounderAccess: Awaited<ReturnType<typeof startCofounderAccess>> = null;
let voiceProcess: ReturnType<typeof startVoiceProcess> | undefined;

async function main(): Promise<void> {
  const port = await companion.listen(PORT);
  assistant.queue.start();
  voiceProcess = startVoiceProcess(projectRoot, `http://127.0.0.1:${port}`, assistant);
  if (front) companion.register(front);
  companion.register(bridge);
  if (!front) companion.register(system);
  if (front) await front.start();
  console.log(front ? (mac!.ready ? "Mac: cua-driver ready — acting in the app in front" : "Mac: cua-driver not answering — Mac apps off (run hermes computer-use doctor)") : "Mac: off");
  console.log(`Jev voice browser → http://localhost:${port}${existsSync(path.join(clientDir, "index.html")) ? "" : "  (client not built: npm run build)"}`);
  console.log(decider.enabled ? `Decisions: TypeSafe Jev (${decider.model})` : "Decisions: keyword heuristics (set TYPESAFE_API_KEY to use Jev)");
  console.log(companion.auth.configured ? "API: bearer token required (JEV_TOKEN)" : "API: disabled — set JEV_TOKEN to enable /api");
  console.log(companion.auth.configured ? "Chrome: waiting for the bridge extension (load dist/extension unpacked; token = JEV_TOKEN)" : "Chrome: bridge disabled — set JEV_TOKEN");
  if (brain) {
    const h = await brain.health();
    console.log(h.ok ? `Brain: ${brain.name} (${h.detail})` : `Brain: ${brain.name} configured but not reachable — ${h.detail}`);
  } else console.log("Brain: none (set OPENROUTER_API_KEY to give Jev a brain)");
  console.log(computer ? "Computer: open apps via open -a" : "Computer: off");
  console.log(describeStt(stt));
  console.log(describeWake(sttListener, stt));
  // Background: render the scripted vocabulary to ~/.jev/tts-cache so the first reply is instant.
  voice.warm((l) => console.log(l));
  wireCofounder(cofounder, companion.announce, (l) => console.log(l));
  cofounderAccess = await startCofounderAccess({
    env: process.env,
    session: () => (companion.hub.defaultId ? (companion.hub.get(companion.hub.defaultId) ?? null) : null),
    look: () => lookAtMac(mac),
    paused: () => companion.hub.paused,
    announce: companion.announce,
    log: (l) => console.log(l),
  });
}

const shutdown = async () => {
  voiceProcess?.stop();
  await cofounderAccess?.close();
  await companion.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
