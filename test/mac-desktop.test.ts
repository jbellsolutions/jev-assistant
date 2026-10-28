import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MacDesktopExecutor } from "../server/executors/mac-desktop.js";
import { appIconPng } from "../app/tray-icon.js";
describe("Mac primary display", () => {
  it("keeps native capture pixels for input while returning a smaller JPEG preview", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const screen = new MacDesktopExecutor(async (tool, args = {}) => {
      calls.push({ tool, args });
      if (tool === "check_permissions") return { accessibility: true, screen_recording: true };
      if (tool === "get_desktop_state") await writeFile(String(args.screenshot_out_file), appIconPng(512));
      return {};
    }, async (_png, jpg) => { await writeFile(jpg, Buffer.from("synthetic-jpeg")); });
    await screen.start(); expect(screen.ready).toBe(true); expect(await screen.screenshot()).toEqual(Buffer.from("synthetic-jpeg"));
    expect(screen.viewport).toEqual({ width: 512, height: 512 });
    await screen.inputClick(.5, 1); expect(calls.at(-1)).toMatchObject({ tool: "click", args: { target: { kind: "desktop", display_id: "primary" }, x: 256, y: 511 } });
    await screen.inputText("synthetic"); expect(calls.at(-1)).toMatchObject({ tool: "type_text", args: { scope: "desktop", text: "synthetic" } });
    await screen.inputKey("cmd+a"); expect(calls.at(-1)).toMatchObject({ tool: "press_key", args: { scope: "desktop", key: "a", modifiers: ["cmd"] } });
  });
  it("does not invent a picture or input coordinate space after a failed capture", async () => {
    const screen = new MacDesktopExecutor(async () => { throw new Error("Screen Recording unavailable"); });
    expect(await screen.screenshot()).toBeNull(); expect(screen.frameProblem).toContain("Screen Recording");
    await expect(screen.inputClick(.5, .5)).rejects.toThrow(/Refresh/);
  });
});
