/** Where the companion lives, from this UI's point of view. The web build talks to the host that
 *  served it; the desktop build gets an explicit address (and token) from the Electron preload. */

import type { ConnectionSettings, ConnectionUpdate } from "../../core/connections.ts";
export interface DesktopBridge {
  windowExpanded?(): Promise<boolean>;
  toggleWindowSize?(): Promise<boolean>;
  setupMac?(): Promise<void>;
  connectionSettings?(): Promise<ConnectionSettings>;
  saveConnections?(update: ConnectionUpdate): Promise<ConnectionSettings>;
  restart?(): Promise<void>;
  openSettings?(): Promise<void>;
  openExtension?(): Promise<void>;
  mode: "desktop";
  /** e.g. "http://127.0.0.1:3111" */
  baseUrl: string;
  /** Escape fired while a command/brain run was in flight: cancel it, stay open. */
  onCancel?(cb: () => void): () => void;
  setBusy?(busy: boolean): void;
  /** Escape or ⌥Space fired while Jev was talking: stop the voice, keep doing the work. */
  onHush?(cb: () => void): () => void;
  setSpeaking?(speaking: boolean): void;
  /** Tuck the panel away (or, if busy, ask to cancel instead — the main process decides). */
  hide?(): void;
  /** The talk key (Fn+Control): start listening, stop and send, or abort without sending. */
  onTalk?(cb: (cmd: "start" | "stop" | "abort") => void): () => void;
  /** Whether the panel window is on screen; called once at once, then on every show/hide. */
  onVisible?(cb: (visible: boolean) => void): () => void;
}

export interface Transport {
  mode: "web" | "desktop";
  /** ws(s):// URL for a socket path such as "/ws" or "/ws/bridge". */
  wsUrl(path: string): string;
  /** http(s):// URL for a companion path such as "/attachments". */
  httpUrl(path: string): string;
}

declare global {
  interface Window {
    jev?: DesktopBridge;
  }
}

export function detectTransport(w: Pick<Window, "jev" | "location"> = window): Transport {
  const bridge = w.jev;
  if (bridge?.mode === "desktop") {
    const base = new URL(bridge.baseUrl);
    const proto = base.protocol === "https:" ? "wss" : "ws";
    return { mode: "desktop", wsUrl: (path) => `${proto}://${base.host}${path}`, httpUrl: (path) => `${base.protocol}//${base.host}${path}` };
  }
  const proto = w.location.protocol === "https:" ? "wss" : "ws";
  return { mode: "web", wsUrl: (path) => `${proto}://${w.location.host}${path}`, httpUrl: (path) => `${w.location.protocol}//${w.location.host}${path}` };
}
