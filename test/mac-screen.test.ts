import { afterEach, describe, expect, it, vi } from "vitest";
import { MacScreens } from "../server/assistant/mac-screen.js";
import { FakeExecutor } from "./helpers/fake-executor.js";
import type { Executor } from "../core/executor.js";
function fixture() {
  const executors: Executor[] = [];
  let blocked: string | null = null;
  const screens = new MacScreens(() => {
    const e = new FakeExecutor([]); e.titleText = `Window ${executors.length + 1}`;
    const surface: Executor = e; surface.screenshot = vi.fn(async () => Buffer.from("synthetic-image"));
    Object.assign(e, { inputClick: vi.fn(async () => "Clicked"), inputText: vi.fn(async () => "Typed"), inputKey: vi.fn(async () => "Key sent") });
    executors.push(e); return e;
  }, () => blocked);
  return { screens, executors, block: (message: string | null) => { blocked = message; } };
}
afterEach(() => vi.useRealTimers());
describe("paired Mac pictures and input", () => {
  it("binds each phone to its own pictured window and refuses another phone's frame", async () => {
    const { screens, executors } = fixture();
    const a = await screens.capture("phone-a", () => true), b = await screens.capture("phone-b", () => true);
    expect(a.title).toBe("Window 1"); expect(b.title).toBe("Window 2");
    await expect(screens.input("phone-b", { frameId: a.frameId, requestId: "wrong-frame", action: "click", fx: .2, fy: .3 }, () => true)).rejects.toThrow(/out of date/);
    await screens.input("phone-a", { frameId: a.frameId, requestId: "valid-input", action: "click", fx: .2, fy: .3 }, () => true);
    expect((executors[0] as any).inputClick).toHaveBeenCalledWith(.2, .3); expect((executors[1] as any).inputClick).not.toHaveBeenCalled();
  });
  it("refuses stale pictures, invalid coordinates and unsupported keys", async () => {
    const { screens, executors } = fixture(); const frame = await screens.capture("a", () => true);
    await expect(screens.input("a", { frameId: frame.frameId, requestId: "bad-coordinate", action: "click", fx: -1, fy: .5 }, () => true)).rejects.toThrow(/supported/);
    await expect(screens.input("a", { frameId: frame.frameId, requestId: "bad-key", action: "key", key: "unknown" }, () => true)).rejects.toThrow(/supported/);
    vi.setSystemTime(Date.now() + 13000);
    await expect(screens.input("a", { frameId: frame.frameId, requestId: "old-frame", action: "key", key: "Enter" }, () => true)).rejects.toThrow(/out of date/);
    expect((executors[0] as any).inputKey).not.toHaveBeenCalled();
  });
  it("does not replay an acknowledged input and requires a new frame after each action", async () => {
    const { screens, executors } = fixture(); const frame = await screens.capture("a", () => true);
    const input = { frameId: frame.frameId, requestId: "send-once", action: "key", key: "Enter" };
    await screens.input("a", input, () => true); await screens.input("a", input, () => true);
    expect((executors[0] as any).inputKey).toHaveBeenCalledTimes(1);
    await expect(screens.input("a", { ...input, requestId: "next-action" }, () => true)).rejects.toThrow(/out of date/);
    await expect(screens.input("a", { ...input, key: "Tab" }, () => true)).rejects.toThrow(/already belongs/);
  });
  it("allows watching active work but blocks manual interference and revocation during capture", async () => {
    const { screens, block, executors } = fixture(); block("Pause the active Mac task first");
    const frame = await screens.capture("a", () => true); expect(frame.canControl).toBe(false);
    await expect(screens.input("a", { frameId: frame.frameId, requestId: "blocked", action: "text", text: "test" }, () => true)).rejects.toThrow(/Pause/);
    block(null); await expect(screens.capture("a", () => false)).rejects.toThrow(/disconnected/);
    screens.drop("a"); await screens.capture("a", () => true); expect(executors).toHaveLength(2);
  });
  it("reports missing screen capture without claiming a live picture", async () => {
    const { screens, executors } = fixture(); await screens.capture("a", () => true);
    executors[0]!.screenshot = async () => null;
    await expect(screens.capture("a", () => true)).rejects.toThrow(/Screen Recording/);
    await expect(new MacScreens(() => null, () => null).capture("a", () => true)).rejects.toThrow(/Mac control is unavailable/);
  });
});
