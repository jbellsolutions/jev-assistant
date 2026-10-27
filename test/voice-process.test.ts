import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startVoiceProcess } from "../server/assistant/voice-process.js";
import type { AssistantRuntime } from "../server/assistant/runtime.js";
import type { spawn } from "node:child_process";

const homes: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function setup() {
  vi.useFakeTimers();
  const root = mkdtempSync(path.join(tmpdir(), "jev-worker-")); homes.push(root);
  for (const dir of ["dist/voice", "build/runtime"]) mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of ["dist/voice/agent.mjs", "build/runtime/node"]) writeFileSync(path.join(root, file), "");
  const workers: Array<EventEmitter & { kill: ReturnType<typeof vi.fn>; stdout: EventEmitter; stderr: EventEmitter }> = [];
  const spawnFake = vi.fn(() => {
    const worker = Object.assign(new EventEmitter(), { kill: vi.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() });
    workers.push(worker); return worker;
  });
  const status = vi.fn(() => ({ connections: { openai: true, livekit: true } }));
  const setVoiceWorker = vi.fn();
  const service = startVoiceProcess(root, "http://127.0.0.1:3111", { status, setVoiceWorker } as unknown as AssistantRuntime, { ELECTRON_RUN_AS_NODE: "1" }, { spawn: spawnFake as unknown as typeof spawn, startupMs: 100, heartbeatMs: 200, retryMs: 10, killMs: 40 });
  return { workers, spawnFake, setVoiceWorker, service };
}
it("recovers an unexpected worker exit with bounded backoff and no overlapping retries", async () => {
  const { workers, spawnFake, setVoiceWorker, service } = setup();
  workers[0]!.emit("exit", 1); workers[0]!.emit("error", new Error("duplicate termination"));
  await vi.advanceTimersByTimeAsync(9); expect(workers).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(workers).toHaveLength(2);
  workers[1]!.emit("exit", 1);
  await vi.advanceTimersByTimeAsync(19); expect(workers).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1); expect(workers).toHaveLength(3);
  workers[2]!.emit("message", { jevVoiceReady: true }); expect(setVoiceWorker).toHaveBeenLastCalledWith("running");
  expect(spawnFake.mock.calls[0]).toBeDefined(); service.stop();
});
it("kills a stuck startup and a worker whose parent heartbeat stops", async () => {
  const { workers, service } = setup();
  await vi.advanceTimersByTimeAsync(100); expect(workers[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  workers[0]!.emit("exit", 1); await vi.advanceTimersByTimeAsync(10);
  workers[1]!.emit("message", { jevVoiceReady: true });
  await vi.advanceTimersByTimeAsync(150); workers[1]!.emit("message", { jevVoiceHeartbeat: true });
  await vi.advanceTimersByTimeAsync(199); expect(workers[1]!.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(workers[1]!.kill).toHaveBeenCalledWith("SIGKILL"); service.stop();
});
it("intentional shutdown never relaunches, even if the worker ignores termination", async () => {
  const { workers, service } = setup();
  service.stop(); service.stop();
  expect(workers[0]!.kill).toHaveBeenCalledTimes(1); expect(workers[0]!.kill).toHaveBeenCalledWith("SIGTERM");
  await vi.advanceTimersByTimeAsync(40); expect(workers[0]!.kill).toHaveBeenLastCalledWith("SIGKILL");
  workers[0]!.emit("exit", 0); await vi.advanceTimersByTimeAsync(120000); expect(workers).toHaveLength(1);
});
