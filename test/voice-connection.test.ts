import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const provider = vi.hoisted(() => ({ deleted: [] as string[], participants: [] as Array<{ identity: string }>, deleteFails: false, dispatch: vi.fn(async () => ({})) }));
vi.mock("livekit-server-sdk", async (original) => ({
  ...await original<typeof import("livekit-server-sdk")>(),
  AgentDispatchClient: class { createDispatch() { return provider.dispatch(); } },
  RoomServiceClient: class {
    async listParticipants() { return provider.participants; }
    async deleteRoom(room: string) { if (provider.deleteFails) throw new Error("network unavailable"); provider.deleted.push(room); throw Object.assign(new Error("Already gone"), { code: "not_found" }); }
  },
}));
import { createCompanion, type Companion } from "../server/companion.js";
import { createAssistantRuntime } from "../server/assistant/runtime.js";
import { HeuristicDecider } from "../core/decide.js";
import { VoiceLeases } from "../server/assistant/voice-leases.js";
let companion: Companion | undefined; let dir: string;
afterEach(async () => { await companion?.close(); companion = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); provider.deleted.length = 0; provider.participants = []; provider.deleteFails = false; provider.dispatch.mockReset().mockResolvedValue({}); vi.restoreAllMocks(); });
async function setup(savedRoom?: string) {
  dir = mkdtempSync(path.join(tmpdir(), "jev-live-recovery-"));
  if (savedRoom) new VoiceLeases(dir).add(savedRoom);
  const runtime = createAssistantRuntime({ env: { JEV_HOME: dir, OPENAI_API_KEY: "fake", LIVEKIT_URL: "wss://test.livekit.cloud", LIVEKIT_API_KEY: "test", LIVEKIT_API_SECRET: "test-secret-long-enough-for-local-token" }, hands: { mac: null, chrome: null, computer: null }, chromeReady: () => false, computerReady: () => false });
  runtime.setVoiceWorker("running"); companion = createCompanion({ assistant: runtime, token: "private", decider: new HeuristicDecider() });
  const port = await companion.listen(0);
  const post = (route: string, body: unknown = { target: "local" }) => fetch(`http://127.0.0.1:${port}/assistant/voice/${route}`, { method: "POST", headers: { authorization: "Bearer private", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { runtime, post };
}
describe("actual voice readiness", () => {
  it("cleans a persisted abandoned room before permitting a new call and retains failed cleanup for retry", async () => {
    const abandoned = "jev-00000000-0000-4000-8000-000000000000";
    const { post } = await setup(abandoned);
    provider.deleteFails = true;
    expect((await post("token")).status).toBe(400); expect(provider.dispatch).not.toHaveBeenCalled();
    expect(new VoiceLeases(dir).list()).toEqual([abandoned]);
    provider.deleteFails = false;
    const next = await (await post("token")).json(); expect(next.room).toMatch(/^jev-/);
    expect(provider.deleted).toContain(abandoned); expect(new VoiceLeases(dir).list()).toEqual([next.room]);
  });
  it("reclaims a disconnected renderer call but preserves a call with its owner still connected", async () => {
    const { post } = await setup(); const first = await (await post("token")).json();
    const owner = JSON.parse(Buffer.from(first.token.split(".")[1], "base64url").toString()).sub;
    const now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now + 11000);
    provider.participants = [{ identity: owner }];
    expect((await post("token")).status).toBe(400); expect(provider.deleted).not.toContain(first.room);
    provider.participants = [{ identity: "agent-only" }];
    const next = await (await post("token")).json(); expect(next.room).toMatch(/^jev-/); expect(next.room).not.toBe(first.room);
    expect(provider.deleted).toContain(first.room);
  });
  it("rejects overlapping starts and restart while dispatch is in flight", async () => {
    const { post, runtime } = await setup(); let finish!: () => void;
    provider.dispatch.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({}); }));
    const pending = post("token");
    await vi.waitFor(() => expect(provider.dispatch).toHaveBeenCalledOnce());
    expect(runtime.canRestart()).toBe(false); expect((await post("token")).status).toBe(400);
    finish(); expect((await pending).status).toBe(200); expect(provider.dispatch).toHaveBeenCalledOnce();
  });
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
