import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AssistantRuntime } from "./runtime.js";
type Options = { spawn?: typeof spawn; startupMs?: number; heartbeatMs?: number; retryMs?: number; killMs?: number };
/** One supervised voice worker. Backoff prevents a failed connection spinning the CPU. */
export function startVoiceProcess(root: string, baseUrl: string, runtime: AssistantRuntime, env: NodeJS.ProcessEnv = process.env, options: Options = {}) {
  let child: ChildProcess | null = null;
  let stopping = false, failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let startup: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  const entry = path.join(root, "dist", "voice", "agent.mjs");
  const node = [path.join(root, "..", "runtime", "node"), path.join(root, "build", "runtime", "node")].find((p) => existsSync(p));
  const clearWatch = () => { clearTimeout(startup); clearTimeout(heartbeat); };
  const launch = () => {
    if (stopping) return;
    runtime.setVoiceWorker("starting", failures ? "Voice service is reconnecting automatically…" : undefined);
    const childEnv: NodeJS.ProcessEnv = { ...env, JEV_COMPANION_URL: baseUrl };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const worker = (options.spawn ?? spawn)(node!, [entry], { env: childEnv, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child = worker;
    let ended = false;
    const finish = () => {
      if (ended) return; ended = true; clearWatch();
      if (child === worker) child = null;
      if (stopping) return;
      runtime.setVoiceWorker("starting", "Voice service stopped. Reconnecting automatically…");
      const delay = Math.min(60000, (options.retryMs ?? 1000) * 2 ** Math.min(failures++, 6));
      retry = setTimeout(launch, delay); retry.unref();
    };
    const armHeartbeat = () => { clearTimeout(heartbeat); heartbeat = setTimeout(() => worker.kill("SIGKILL"), options.heartbeatMs ?? 60000); heartbeat.unref(); };
    worker.on("message", (message) => {
      if (stopping || child !== worker || !message || typeof message !== "object") return;
      if ("jevVoiceReady" in message) { clearTimeout(startup); failures = 0; runtime.setVoiceWorker("running"); armHeartbeat(); }
      else if ("jevVoiceHeartbeat" in message) armHeartbeat();
    });
    // Provider logs may contain private metadata. Surface only safe state transitions above.
    worker.stdout?.on("data", () => {}); worker.stderr?.on("data", () => {});
    worker.once("error", finish); worker.once("exit", finish);
    startup = setTimeout(() => worker.kill("SIGKILL"), options.startupMs ?? 35000); startup.unref();
  };
  if (!runtime.status().connections.openai || !runtime.status().connections.livekit) return { stop() {} };
  if (!existsSync(entry) || !node) { runtime.setVoiceWorker("error", "Voice runtime is missing. Reinstall the latest Jev preview."); return { stop() {} }; }
  launch();
  return { stop() {
    if (stopping) return; stopping = true; clearTimeout(retry); clearWatch();
    const worker = child; child = null;
    if (!worker) return;
    const kill = setTimeout(() => worker.kill("SIGKILL"), options.killMs ?? 4000); kill.unref();
    worker.once("exit", () => clearTimeout(kill)); worker.kill("SIGTERM");
  } };
}
