import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("livekit-server-sdk", async (original) => ({
  ...await original<typeof import("livekit-server-sdk")>(),
  AgentDispatchClient: class { async createDispatch() { return {}; } },
  RoomServiceClient: class { async deleteRoom() { throw Object.assign(new Error("Already gone"), { code: "not_found" }); } },
}));
import { createCompanion, type Companion } from "../server/companion.js";
import { createAssistantRuntime } from "../server/assistant/runtime.js";
import { HeuristicDecider } from "../core/decide.js";
let companion: Companion | undefined; let dir: string;
afterEach(async () => { await companion?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
describe("actual voice readiness", () => {
  it("does not equate LiveKit dispatch with model readiness, retains failure and cleans an already closed room", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "jev-live-state-"));
    const runtime = createAssistantRuntime({ env: { JEV_HOME: dir, OPENAI_API_KEY: "fake", LIVEKIT_URL: "wss://test.livekit.cloud", LIVEKIT_API_KEY: "test", LIVEKIT_API_SECRET: "test-secret-long-enough-for-local-token" }, hands: { mac: null, chrome: null, computer: null }, chromeReady: () => false, computerReady: () => false });
    runtime.setVoiceWorker("running");
    companion = createCompanion({ assistant: runtime, token: "private", decider: new HeuristicDecider() });
    const port = await companion.listen(0);
    const post = async (route: string, body: unknown) => fetch(`http://127.0.0.1:${port}/assistant/voice/${route}`, { method: "POST", headers: { authorization: "Bearer private", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const info = await (await post("token", { target: "orgo" })).json(); expect(info.room).toMatch(/^jev-/);
    expect(runtime.canRestart()).toBe(false);
    expect(await (await post("connection", { room: info.room })).json()).toEqual({ state: "connecting" });
    await post("state", { room: info.room, state: "ready" });
    expect(await (await post("connection", { room: info.room })).json()).toEqual({ state: "ready" });
    await post("state", { room: info.room, state: "failed", failure: "quota", rawError: "must never leave server" });
    await post("state", { room: info.room, state: "ready" });
    expect(await (await post("connection", { room: info.room })).json()).toEqual({ state: "failed", failure: "quota" });
    expect((await post("end", { room: info.room })).status).toBe(200); expect(runtime.canRestart()).toBe(true);
    expect((await post("connection", { room: info.room })).status).toBe(400);
  });
});
