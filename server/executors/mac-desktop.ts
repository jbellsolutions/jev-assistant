import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Executor, ExecutorCapabilities } from "../../core/executor.js";
import type { Action } from "../../core/actions.js";
import { driverKey } from "../../core/mac.js";
import { cliDriver, type Driver } from "./mac.js";

const convertPreview = (png: string, jpg: string) => new Promise<void>((resolve, reject) => execFile("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", "1440", png, "--out", jpg], (e) => e ? reject(e) : resolve()));

/** Primary-display capture/input for the paired human, including sheets and system dialogs. */
export class MacDesktopExecutor implements Executor {
  readonly id = "mac-display";
  readonly kind = "mac" as const;
  readonly capabilities: ExecutorCapabilities = { screenshot: true, viewport: false, clickAt: true, read: false };
  viewport = { width: 0, height: 0 };
  ready = false;
  frameProblem: string | null = null;
  readonly url = "app://mac-display";
  constructor(private driver: Driver = cliDriver(), private convert = convertPreview) {}
  async start() { const p = await this.driver("check_permissions", {}) as { accessibility?: boolean; screen_recording?: boolean }; this.ready = p.accessibility === true && p.screen_recording === true; }
  async title() { return "Mac primary display"; }
  async frameInfo() { return { url: this.url, title: "Mac primary display" }; }
  async snapshot() { return { title: "Mac primary display", url: this.url, elements: [] }; }
  async screenshot(): Promise<Uint8Array | null> {
    const id = randomUUID(), png = path.join(tmpdir(), `jarvis-display-${id}.png`), jpg = path.join(tmpdir(), `jarvis-display-${id}.jpg`);
    try {
      await this.driver("get_desktop_state", { screenshot_out_file: png });
      const raw = await readFile(png);
      // The driver promises native screen pixels. Preserve that coordinate space before scaling the preview.
      if (raw.length < 24 || raw.toString("hex", 0, 8) !== "89504e470d0a1a0a") throw new Error("Invalid display capture");
      this.viewport = { width: raw.readUInt32BE(16), height: raw.readUInt32BE(20) };
      await this.convert(png, jpg);
      const image = await readFile(jpg); this.frameProblem = null; return image;
    } catch { this.frameProblem = "The Mac display could not be captured. Check Cua Driver Screen Recording permission and keep the Mac awake and unlocked."; return null; }
    finally { await Promise.all([rm(png, { force: true }), rm(jpg, { force: true })]); }
  }
  async inputClick(fx: number, fy: number) {
    if (!this.viewport.width || !this.viewport.height) throw new Error("Refresh the Mac display first.");
    await this.driver("click", { target: { kind: "desktop", display_id: "primary" }, x: Math.round(fx * (this.viewport.width - 1)), y: Math.round(fy * (this.viewport.height - 1)) });
    return "Click sent to the Mac display; inspect the new picture.";
  }
  async inputText(text: string) { await this.driver("type_text", { scope: "desktop", text }); return "Text sent to the focused Mac field; inspect the new picture."; }
  async inputKey(key: string) { const k = driverKey(key); await this.driver("press_key", { scope: "desktop", key: k.key, ...(k.modifiers.length ? { modifiers: k.modifiers } : {}) }); return "Key sent to the Mac; inspect the new picture."; }
  async execute(_action: Action): Promise<string> { throw new Error("Use the paired display controls."); }
  async setViewport() { return false; }
  onChange() { return () => {}; }
  async close() {}
}
