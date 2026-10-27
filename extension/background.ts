/** Service worker: keeps a socket to the companion, tracks the active tab, and carries out
 *  requests on it — navigation itself, everything in the page through the content script. Requests
 *  marked `tab: "jev"` run in Jev's own minimized window instead, so the brain can use the user's
 *  logins without touching what he is looking at.
 *  MV3 workers are put to sleep when idle; socket traffic every 20 s and an alarm keep the
 *  bridge alive and reconnecting. */
import type { Action } from "../core/actions.js";
import { BRIDGE_PROTOCOL, type FromBridge, type RemoteOp, type RemoteResult, type TabInfo, type TabTarget, type ToBridge } from "../core/remote.js";
import type { ContentRequest, ContentResponse } from "./content.js";

const DEFAULTS = { url: "ws://127.0.0.1:3111/ws/bridge", token: "" };
const PING_MS = 20_000;
const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000];

let socket: WebSocket | null = null;
let attempts = 0;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Where the companion is. Saved settings win; otherwise config.json, which the build writes
 *  next to this file from the companion's own .env, so loading the folder is all the pairing
 *  there is (nothing to type). */
async function settings(): Promise<{ url: string; token: string }> {
  const stored = (await chrome.storage.local.get(["url", "token"])) as Partial<typeof DEFAULTS>;
  if (stored.url?.trim() || stored.token?.trim()) return { url: stored.url?.trim() || DEFAULTS.url, token: stored.token?.trim() || "" };
  try {
    const res = await fetch(chrome.runtime.getURL("config.json"));
    const cfg = (await res.json()) as Partial<typeof DEFAULTS>;
    return { url: cfg.url?.trim() || DEFAULTS.url, token: cfg.token?.trim() || "" };
  } catch {
    return { ...DEFAULTS };
  }
}

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) return tab;
  const [any] = await chrome.tabs.query({ active: true });
  return any ?? null;
}

/** Jev's own window: minimized, never focused, same profile — so every site the user is signed into
 *  works there, and nothing he is looking at changes. Remembered for the browser session; made
 *  again if he closes it. */
async function jevTab(): Promise<chrome.tabs.Tab> {
  const { jevWindowId } = (await chrome.storage.session.get("jevWindowId")) as { jevWindowId?: number };
  if (jevWindowId !== undefined) {
    const win = await chrome.windows.get(jevWindowId, { populate: true }).catch(() => null);
    const tab = win?.tabs?.find((t) => t.active) ?? win?.tabs?.[0];
    if (tab) {
      // Left up on screen but not being looked at: tuck it away again. Focused means he opened it
      // to watch — leave that alone.
      if (win && win.state === "normal" && !win.focused) await chrome.windows.update(win.id!, { state: "minimized" }).catch(() => {});
      return tab;
    }
  }
  // Chrome on macOS ignores `state: "minimized"` at creation: the window came up full size, on top
  // of the user's (seen 2026-09-26). Created unfocused, then minimized straight away, it goes to the
  // Dock without ever taking focus — measured in Chromium on this Mac.
  const win = await chrome.windows.create({ url: "about:blank", focused: false });
  if (win?.id !== undefined && win.state !== "minimized") await chrome.windows.update(win.id, { state: "minimized" }).catch(() => {});
  await chrome.storage.session.set({ jevWindowId: win?.id });
  const tab = win?.tabs?.[0];
  if (!tab) throw new Error("Couldn't open Jev's background window in Chrome");
  return tab;
}

/** The tab an op is for: Jev's own (background) or the one the user is looking at. */
async function targetTab(target: TabTarget | undefined): Promise<chrome.tabs.Tab | null> {
  return target === "jev" ? jevTab() : activeTab();
}

const info = (tab: chrome.tabs.Tab | null): TabInfo | null => (tab ? { url: tab.url ?? "", title: tab.title ?? "" } : null);

const scriptable = (tab: chrome.tabs.Tab): boolean => /^(https?|file):/.test(tab.url ?? "");

/** Ask the content script; inject it first when the tab predates the extension. */
async function askContent(tab: chrome.tabs.Tab, req: ContentRequest): Promise<ContentResponse> {
  if (!tab.id) throw new Error("No tab is active");
  if (!scriptable(tab)) throw new Error(`Can't act on this page (${tab.url?.split("/")[0] ?? "internal"} pages are off limits)`);
  const send = () => chrome.tabs.sendMessage(tab.id!, req) as Promise<ContentResponse>;
  try {
    return await send();
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return await send();
  }
}

async function waitForLoad(tabId: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status === "complete" || Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function navigate(tab: chrome.tabs.Tab, url: string): Promise<void> {
  if (!tab.id) throw new Error("No tab is active");
  await chrome.tabs.update(tab.id, { url });
  await waitForLoad(tab.id);
}

async function execute(action: Action, target: TabTarget | undefined): Promise<string> {
  const tab = await targetTab(target);
  if (!tab) throw new Error("No tab is active in Chrome");
  switch (action.kind) {
    case "navigate":
      await navigate(tab, action.url);
      return `Opened ${action.url}`;
    case "search":
      await navigate(tab, action.url);
      return `Searched for "${action.query}"`;
    case "back":
      if (tab.id) await chrome.tabs.goBack(tab.id).catch(() => {});
      return "Went back";
    case "forward":
      if (tab.id) await chrome.tabs.goForward(tab.id).catch(() => {});
      return "Went forward";
    case "reload":
      if (tab.id) {
        await chrome.tabs.reload(tab.id);
        await waitForLoad(tab.id);
      }
      return "Reloaded";
    case "stop":
      return "Stopped";
    case "open_app":
      throw new Error(`The browser can't open ${action.app}`);
    case "none":
      return action.reason;
    default: {
      const res = await askContent(tab, { op: "execute", action });
      if (!res.ok) throw new Error(res.error);
      // a click may have started a navigation: give it a moment so the next snapshot is fresh
      if (action.kind === "click" || (action.kind === "type" && action.submit) || action.kind === "press") {
        await new Promise((r) => setTimeout(r, 250));
        if (tab.id) await waitForLoad(tab.id, 3_000);
      }
      return res.status ?? "Done";
    }
  }
}

async function perform(req: RemoteOp): Promise<RemoteResult> {
  switch (req.op) {
    case "tab":
      return { op: "tab", tab: info(await targetTab(req.tab)) };
    case "snapshot": {
      const tab = await targetTab(req.tab);
      if (!tab) throw new Error("No tab is active in Chrome");
      if (!scriptable(tab)) return { op: "snapshot", snapshot: { url: tab.url ?? "", title: tab.title ?? "", elements: [] } };
      const res = await askContent(tab, { op: "snapshot", max: req.max });
      if (!res.ok) throw new Error(res.error);
      return { op: "snapshot", snapshot: { url: tab.url ?? "", title: res.title ?? tab.title ?? "", elements: res.elements ?? [] } };
    }
    case "read": {
      const tab = await targetTab(req.tab);
      if (!tab) throw new Error("No tab is active in Chrome");
      if (!scriptable(tab)) return { op: "read", page: { text: "", truncated: false, chars: 0 } };
      const res = await askContent(tab, { op: "read", max: req.max });
      if (!res.ok) throw new Error(res.error);
      return { op: "read", page: res.page ?? { text: "", truncated: false, chars: 0 } };
    }
    case "execute":
      return { op: "execute", status: await execute(req.action, req.tab) };
    case "screenshot": {
      if (req.tab === "jev") return { op: "screenshot", jpegBase64: null }; // minimized: nothing to capture
      const tab = await activeTab();
      if (!tab?.windowId) return { op: "screenshot", jpegBase64: null };
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: req.quality });
        return { op: "screenshot", jpegBase64: dataUrl.slice(dataUrl.indexOf(",") + 1) };
      } catch {
        return { op: "screenshot", jpegBase64: null };
      }
    }
  }
}

function send(msg: FromBridge): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

async function onMessage(raw: string): Promise<void> {
  let msg: ToBridge;
  try {
    msg = JSON.parse(raw) as ToBridge;
  } catch {
    return;
  }
  if (msg.type === "ping") return send({ type: "pong" });
  if (msg.type !== "exec_req") return;
  try {
    send({ type: "exec_res", id: msg.id, ok: true, result: await perform(msg.req) });
  } catch (err) {
    send({ type: "exec_res", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Startup, alarms and retries can all call connect(); only one may be under way, or two sockets
 *  open and the first one's close clears the badge of the one that stayed. */
let connecting = false;

async function connect(): Promise<void> {
  if (connecting || (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connecting = true;
  try {
    await openBridge();
  } finally {
    connecting = false;
  }
}

async function openBridge(): Promise<void> {
  const { url, token } = await settings();
  // Ask over plain HTTP first. A WebSocket to a Jev that isn't running (or that refuses the
  // token) is logged by Chrome as an error on chrome://extensions every retry; a caught fetch
  // and a 200 are not.
  const ready = await bridgeReady(url, token);
  if (ready !== "ok") {
    void chrome.action.setBadgeText({ text: ready === "wrong" || ready === "unset" ? "key" : "" });
    void chrome.action.setTitle({ title: ready === "down" ? "Jev bridge — waiting for Jev to start" : "Jev bridge — Jev refused the token: reload the extension from jev/dist/extension" });
    return scheduleReconnect();
  }
  void chrome.action.setTitle({ title: "Jev bridge — connected" });
  const target = new URL(url);
  if (token) target.searchParams.set("token", token);
  let ws: WebSocket;
  try {
    ws = new WebSocket(target.toString());
  } catch {
    return scheduleReconnect();
  }
  socket = ws;
  const opening = setTimeout(() => { if (socket === ws && ws.readyState === WebSocket.CONNECTING) ws.close(); }, 5000);
  ws.onopen = async () => {
    clearTimeout(opening);
    if (socket !== ws) return ws.close();
    attempts = 0;
    send({ type: "hello", protocol: BRIDGE_PROTOCOL, agent: `jev-chrome-bridge/${chrome.runtime.getManifest().version}`, tab: info(await activeTab()) });
    void chrome.action.setBadgeText({ text: "on" });
    void chrome.action.setBadgeBackgroundColor({ color: "#1a7f37" });
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: "pong" }), PING_MS); // traffic keeps the worker alive
  };
  ws.onmessage = (ev) => { if (socket === ws) void onMessage(String(ev.data)); };
  ws.onclose = () => {
    clearTimeout(opening);
    if (socket !== ws) return;
    socket = null;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    void chrome.action.setBadgeText({ text: "" });
    void chrome.action.setTitle({ title: "Jev bridge — reconnecting to Jev" });
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

/** "down" when nothing answers; otherwise what Jev thinks of the token. */
async function bridgeReady(url: string, token: string): Promise<"ok" | "wrong" | "unset" | "down"> {
  try {
    const probe = new URL(url);
    probe.protocol = probe.protocol === "wss:" ? "https:" : "http:";
    probe.pathname = "/api/bridge-ready";
    probe.search = "";
    const res = await fetch(probe, { headers: token ? { authorization: `Bearer ${token}` } : {}, cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!res.ok) return "ok"; // an older Jev without this route: let the socket try, as before
    const body = (await res.json()) as { token?: string };
    return body.token === "ok" || body.token === "wrong" || body.token === "unset" ? body.token : "down";
  } catch {
    return "down";
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = RECONNECT_MS[Math.min(attempts++, RECONNECT_MS.length - 1)]!;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, delay);
}

async function announceTab(): Promise<void> {
  send({ type: "tab", tab: info(await activeTab()) });
}

chrome.tabs.onActivated.addListener(() => void announceTab());
chrome.windows.onFocusChanged.addListener(() => void announceTab());
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (!((change.status === "complete" || change.url || change.title) && tab.active)) return;
  void chrome.storage.session.get("jevWindowId").then(({ jevWindowId }) => {
    if (tab.windowId !== jevWindowId) void announceTab(); // Jev's own window is not where the user is
  });
});
chrome.storage.onChanged.addListener((_changes, area) => {
  // only the pairing settings (local) mean "reconnect"; Jev's window id lives in session storage
  if (area !== "local") return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  socket?.close();
  socket = null;
  attempts = 0;
  void connect();
});
chrome.alarms.create("jev-bridge-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
void connect();
