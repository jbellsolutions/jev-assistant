/** Runs in the renderer before the page, with Node isolated away. Exposes only what the UI
 *  needs from the shell: that it is the desktop build, where the companion is, and the hotkey. */
import { contextBridge, ipcRenderer } from "electron";

const baseUrl = process.argv.find((a) => a.startsWith("--jev-base-url="))?.slice("--jev-base-url=".length) ?? "";

contextBridge.exposeInMainWorld("jev", {
  windowExpanded() { return ipcRenderer.invoke("jev:window:expanded"); },
  toggleWindowSize() { return ipcRenderer.invoke("jev:window:toggle"); },
  setupMac() { return ipcRenderer.invoke("jev:mac-setup"); },
  connectionSettings() { return ipcRenderer.invoke("jev:connections:get"); },
  saveConnections(update: unknown) { return ipcRenderer.invoke("jev:connections:save", update); },
  restart() { return ipcRenderer.invoke("jev:restart"); },
  openSettings(): Promise<void> { return ipcRenderer.invoke("jev:settings"); },
  openExtension(): Promise<void> { return ipcRenderer.invoke("jev:extension"); },
  mode: "desktop",
  baseUrl,
  /** Escape or the busy tray icon asked to cancel the current command/brain run. */
  onCancel(cb: () => void): () => void {
    const handler = () => cb();
    ipcRenderer.on("jev:cancel", handler);
    return () => ipcRenderer.off("jev:cancel", handler);
  },
  setBusy(busy: boolean): void {
    ipcRenderer.send("jev:busy", busy);
  },
  /** Escape or ⌥Space asked Jev to stop talking (without stopping what she is doing). */
  onHush(cb: () => void): () => void {
    const handler = () => cb();
    ipcRenderer.on("jev:hush", handler);
    return () => ipcRenderer.off("jev:hush", handler);
  },
  setSpeaking(speaking: boolean): void {
    ipcRenderer.send("jev:speaking", speaking);
  },
  /** The talk key (Fn+Control): start listening, stop and send, or abort without sending. */
  onTalk(cb: (cmd: "start" | "stop" | "abort") => void): () => void {
    const handler = (_e: unknown, cmd: "start" | "stop" | "abort") => cb(cmd);
    ipcRenderer.on("jev:talk", handler);
    return () => ipcRenderer.off("jev:talk", handler);
  },
  hide(): void {
    ipcRenderer.send("jev:hide");
  },
  /** Whether the panel window is on screen, now and as it changes. */
  onVisible(cb: (visible: boolean) => void): () => void {
    const handler = (_e: unknown, visible: boolean) => cb(visible);
    ipcRenderer.on("jev:visible", handler);
    void ipcRenderer.invoke("jev:is-visible").then((v: boolean) => cb(v));
    return () => ipcRenderer.off("jev:visible", handler);
  },
});
