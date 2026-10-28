import { createHash, randomUUID } from "node:crypto";
import type { Executor } from "../../core/executor.js";

export interface MacFrame { frameId: string; at: number; title: string; jpegBase64: string; canControl: boolean; controlMessage: string }
interface ScreenSession { executor: Executor; busy: boolean; frame?: MacFrame; receipts: Map<string, { fingerprint: string; result: Promise<{ message: string }> }> }

/** Each paired device owns its pictured window and input state. No desktop WebSocket is exposed. */
export class MacScreens {
  private sessions = new Map<string, ScreenSession>();
  constructor(private factory: () => Executor | null, private blocked: () => string | null) {}
  drop(device: string) { this.sessions.delete(device); }
  private session(device: string): ScreenSession {
    let s = this.sessions.get(device);
    if (!s) {
      const executor = this.factory();
      if (!executor) throw new Error("Mac control is unavailable. Open Jarvis on the Mac and enable Cua Driver in Accessibility and Screen Recording.");
      s = { executor, busy: false, receipts: new Map() }; this.sessions.set(device, s);
    }
    return s;
  }
  async capture(device: string, authorized: () => boolean): Promise<MacFrame> {
    const s = this.session(device);
    if (s.busy) throw new Error("A screen request is still running. Refresh in a moment.");
    s.busy = true; s.frame = undefined;
    try {
      if (s.executor.ready === false) await s.executor.start();
      const image = await s.executor.screenshot();
      if (!authorized()) throw new Error("This phone was disconnected.");
      if (!image?.length) { s.frame = undefined; throw new Error(s.executor.frameProblem || "Mac picture unavailable. Check Screen Recording permission, unlock the Mac and open an app window."); }
      const info = s.executor.frameInfo ? await s.executor.frameInfo() : { title: await s.executor.title() };
      const blocked = this.blocked();
      const canInput = !!s.executor.inputClick && !!s.executor.inputText && !!s.executor.inputKey;
      s.frame = { frameId: randomUUID(), at: Date.now(), title: info.title, jpegBase64: Buffer.from(image).toString("base64"), canControl: !blocked && canInput, controlMessage: blocked || (canInput ? "Tap the picture, type, or send a key to this Mac." : "This screen is view-only.") };
      return s.frame;
    } finally { s.busy = false; }
  }
  input(device: string, body: unknown, authorized: () => boolean): Promise<{ message: string }> {
    const s = this.session(device);
    const b = body as { requestId?: unknown; frameId?: unknown; action?: unknown; fx?: unknown; fy?: unknown; text?: unknown; key?: unknown } | null;
    if (!b || typeof b.requestId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(b.requestId)) return Promise.reject(new Error("Input needs a request ID."));
    const fingerprint = createHash("sha256").update(JSON.stringify(b)).digest("hex");
    const prior = s.receipts.get(b.requestId);
    if (prior) return prior.fingerprint === fingerprint ? prior.result : Promise.reject(new Error("That request ID already belongs to another input."));
    if (s.busy) return Promise.reject(new Error("Wait for the current screen request before sending input."));
    const result = (async () => {
      s.busy = true;
      try {
        if (!authorized()) throw new Error("This phone was disconnected.");
        const blocked = this.blocked(); if (blocked) throw new Error(blocked);
        if (!s.frame || s.frame.frameId !== b.frameId || Date.now() - s.frame.at > 12000) throw new Error("That picture is out of date. Refresh it before acting.");
        let message: string;
        if (b.action === "click" && typeof b.fx === "number" && Number.isFinite(b.fx) && b.fx >= 0 && b.fx <= 1 && typeof b.fy === "number" && Number.isFinite(b.fy) && b.fy >= 0 && b.fy <= 1 && s.executor.inputClick) {
          s.frame = undefined; message = await s.executor.inputClick(b.fx, b.fy);
        } else if (b.action === "text" && typeof b.text === "string" && b.text.length > 0 && b.text.length <= 4000 && s.executor.inputText) {
          s.frame = undefined; message = await s.executor.inputText(b.text);
        } else if (b.action === "key" && typeof b.key === "string" && ["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "cmd+a", "cmd+c", "cmd+v", "cmd+f", "cmd+o", "cmd+shift+g", "cmd+space"].includes(b.key) && s.executor.inputKey) {
          s.frame = undefined; message = await s.executor.inputKey(b.key);
        } else throw new Error("Choose a supported screen input.");
        return { message };
      } finally { s.busy = false; }
    })();
    s.receipts.set(b.requestId, { fingerprint, result });
    if (s.receipts.size > 50) s.receipts.delete(s.receipts.keys().next().value!);
    return result;
  }
}
