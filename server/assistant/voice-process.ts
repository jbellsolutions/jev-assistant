import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AssistantRuntime } from "./runtime.js";
/** Voice worker is separate from Electron's main event loop and owns no browser/controller. */
export function startVoiceProcess(root: string, baseUrl: string, runtime: AssistantRuntime, env: NodeJS.ProcessEnv = process.env) {
  let child: ChildProcess | null = null;
  if (!runtime.status().connections.openai || !runtime.status().connections.livekit) return { stop() {} };
  const entry = path.join(root, "dist", "voice", "agent.mjs");
  const node = [path.join(root, "..", "runtime", "node"), path.join(root, "build", "runtime", "node")].find((p) => existsSync(p));
  if (!existsSync(entry)) { runtime.setVoiceWorker("error", "Build the voice worker before connecting"); return { stop() {} }; }
  if (!node) { runtime.setVoiceWorker("error", "Build the bundled voice runtime before connecting"); return { stop() {} }; }
  runtime.setVoiceWorker("starting");
  const childEnv: NodeJS.ProcessEnv = { ...env, JEV_COMPANION_URL: baseUrl };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  child = spawn(node, [entry], {
    env: childEnv, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.on("message", (msg) => { if (msg && typeof msg === "object" && "jevVoiceReady" in msg) runtime.setVoiceWorker("running"); });
  child.stdout?.on("data", () => {}); // Provider logs may contain private session metadata; do not forward them.
  child.stderr?.on("data", () => {});
  child.on("error", () => runtime.setVoiceWorker("error", "Voice worker could not start. Check the local installation."));
  child.on("exit", (code) => { runtime.setVoiceWorker("error", `Voice worker stopped (${code ?? "signal"}). Restart Jev after checking connection settings.`); child = null; });
  return { stop() { child?.kill("SIGTERM"); } };
}
