/** The Jarvis desktop face: a floating always-on-top panel over the same companion the CLI runs,
 *  in-process. ⌥Space shows and focuses the panel; the tray shows what it is doing. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, Menu, Tray, app, globalShortcut, ipcMain, nativeImage, screen, session, shell, systemPreferences } from "electron";
import { createDecider } from "../core/decide.js";
import { createCompanion } from "../server/companion.js";
import { selectComputer } from "../server/computer.js";
import { loadEnvFile } from "../server/env.js";
import { loadConfiguration } from "../server/configuration.js";
import { connectionSettings, saveConnections } from "../server/credentials.js";
import { createAssistantRuntime } from "../server/assistant/runtime.js";
import { startVoiceProcess } from "../server/assistant/voice-process.js";
import { prepareExtension } from "../server/assistant/extension.js";
import { windowSize, saveWindowSize } from "./window-size.js";
import { createBrain } from "../server/brain/index.js";
import { selectBrowserBox, browserViewUrl } from "../server/browserbox.js";
import { FrontExecutor } from "../server/executors/front.js";
import { selectMac } from "../server/executors/mac.js";
import { SystemBrowser } from "../server/executors/system-browser.js";
import { RemoteExecutor } from "../server/executors/remote.js";
import { createVoice } from "../server/speak/start.js";
import { selectCofounder, wireCofounder } from "../server/cofounder.js";
import { selectOrgo } from "../server/orgo.js";
import { startCofounderAccess } from "../server/mcp-remote.js";
import { lookAtMac } from "../server/brain/tools.js";
import { MuteSwitch } from "../server/speak/gate.js";
import { readState } from "../server/state.js";
import { deviceReader } from "../server/speak/device.js";
import { describeStt, describeWake, selectSttProvider, selectWakeListener } from "../server/stt/select.js";
import { type PanelState, TALK_IDLE, type TalkState, onEscape, onHotkey, onPaused, onRendererBusy, onRendererSpeaking, onTalkKey, onWindowVisibility } from "./hotkey.js";
import { type TalkKeyStatus, comboLabel, startTalkKeys } from "./talk-keys.js";
import { trayIconPng } from "./tray-icon.js";

const here = path.dirname(fileURLToPath(import.meta.url)); // dist/app
const root = path.join(here, "..", "..");
// Preserve existing chat, layout and permissions when the product name changes.
if (app.isPackaged && !process.argv.some((a) => a.startsWith("--user-data-dir="))) app.setPath("userData", path.join(app.getPath("appData"), "Jev"));
app.setName("Jarvis");
loadConfiguration(root);
// The app is launched from the Dock / at login with no shell around it: read the project's .env itself.
const envKeys = loadEnvFile(path.join(root, ".env"));
const PORT = Number(process.env.JEV_APP_PORT ?? 3111);
const HOTKEY = process.env.JEV_HOTKEY ?? "Alt+Space";
/** Hold to talk, tap for hands-free (native/jev-keys). "off" disables it. */
const TALK_KEYS = process.env.JEV_TALK_KEYS ?? "fn+control";
let talk: TalkState = TALK_IDLE;
let talkStatus: TalkKeyStatus | "off" = "off";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let panel: PanelState = { visible: false, busy: false };
let baseUrl = "";

let buildTrayMenu: () => Menu = () => Menu.buildFromTemplate([]);

function icon(kind: "idle" | "busy" | "paused") {
  const img = nativeImage.createFromBuffer(trayIconPng(kind, 44), { scaleFactor: 2 });
  img.setTemplateImage(true);
  return img;
}

function runHotkey() {
  const { state, effects } = onHotkey(panel);
  panel = state;
  applyEffects(effects);
}

function runEscape() {
  const { state, effects } = onEscape(panel);
  panel = state;
  applyEffects(effects);
}

function applyEffects(effects: ReturnType<typeof onHotkey>["effects"]) {
  if (quitting) return;
  for (const e of effects) {
    switch (e) {
      case "show":
        showPanel();
        break;
      case "hide":
        win?.hide();
        break;
      case "focus":
        win?.focus();
        break;
      case "cancel":
        // the renderer holds the companion socket; it stops the current run and sends "stop"
        win?.webContents.send("jev:cancel");
        break;
      case "hush":
        // just the voice: whatever she was doing carries on, and the panel stays where it is
        win?.webContents.send("jev:hush");
        break;
      case "resume":
        setPaused(false);
        break;
    }
  }
  refreshTray();
}

let setPaused: (paused: boolean) => void = () => {};

function refreshTray() {
  if (quitting || !tray || tray.isDestroyed()) return;
  tray?.setImage(icon(panel.paused ? "paused" : panel.busy ? "busy" : "idle"));
  tray?.setToolTip(panel.paused ? "Jarvis — paused (⌥Space or the menu to resume)" : panel.busy ? "Jarvis — working (Esc to stop)" : `Jarvis — ${HOTKEY.replace("Alt", "⌥").replace("+", "")} to show`);
  tray?.setContextMenu(buildTrayMenu());
}

function placeBottomRight(w: BrowserWindow) {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height } = w.getBounds();
  w.setPosition(Math.max(workArea.x, workArea.x + workArea.width - width - 16), Math.max(workArea.y, workArea.y + workArea.height - height - 16), false);
}

function showPanel() {
  if (quitting || !baseUrl) return;
  if (!win || win.isDestroyed()) win = createWindow();
  if (!win.isVisible()) placeBottomRight(win);
  win.show();
  panel = onWindowVisibility(panel, true);
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    ...windowSize(process.env.JEV_HOME!, screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea),
    minWidth: 360,
    minHeight: 480,
    show: false,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    resizable: true,
    fullscreenable: true,
    skipTaskbar: true,
    titleBarStyle: "hidden",
    vibrancy: "under-window",
    visualEffectState: "active",
    backgroundColor: "#10141b",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Wake mode's whole point is being heard from across the room with the panel hidden (Escape),
      // and Chromium throttles timers in a hidden window. The microphone must not be one of them.
      backgroundThrottling: false,
      additionalArguments: [`--jev-base-url=${baseUrl}`],
    },
  });
  w.on("closed", () => { if (win === w) win = null; });
  let rendererRestarts = 0;
  w.webContents.on("render-process-gone", () => {
    if (!quitting && !w.isDestroyed() && rendererRestarts++ < 3) void w.loadURL(`${baseUrl}/?mode=desktop`);
  });
  // renderer console → our stdout, so `electron .` logs tell the whole story
  w.webContents.on("console-message", (ev) => {
    const level = ev.level === "error" ? "ERR" : ev.level === "warning" ? "WARN" : "LOG";
    console.log(`[renderer ${level}] ${ev.message}`);
  });
  w.setAlwaysOnTop(true, "floating");
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  w.on("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!w.isDestroyed() && !w.isFullScreen()) { const { width, height } = w.getBounds(); try { saveWindowSize(process.env.JEV_HOME!, { width, height }); } catch {} } }, 250); });
  // Deliberately not `{ visibleOnFullScreen: true }`: that flag sets the window's collection
  // behavior to NSWindowCollectionBehaviorFullScreenAuxiliary, which macOS then also uses to
  // classify the *app* as an accessory (UIElement) — no Dock icon, even with an explicit
  // `setActivationPolicy("regular")` — live-verified by bisecting this exact flag. A normal Dock
  // icon (the user's choice) wins; the tradeoff is the panel no longer floats over a full-screened app.
  w.setVisibleOnAllWorkspaces(true);
  w.on("close", (e) => {
    // closing the panel just hides it; the tray keeps the assistant alive
    if (!quitting) {
      e.preventDefault();
      w.hide();
    }
  });
  // backgroundThrottling is off, so the page itself always reports "visible": say it from here.
  const visibility = (visible: boolean) => {
    if (quitting || w.isDestroyed()) return;
    panel = onWindowVisibility(panel, visible);
    refreshTray();
    w.webContents.send("jev:visible", visible);
  };
  w.on("hide", () => visibility(false));
  w.on("minimize", () => visibility(false));
  w.on("show", () => visibility(!w.isMinimized()));
  w.on("restore", () => visibility(true));
  // The panel never leaves the companion: a file dropped outside the drop zone would otherwise
  // replace the whole panel with file:///…pdf.
  w.webContents.on("will-navigate", (e, url) => {
    if (new URL(url).origin !== baseUrl) e.preventDefault();
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  void w.loadURL(`${baseUrl}/?mode=desktop`);
  return w;
}

let quitting = false;

async function main() {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on("second-instance", () => showPanel());
  await app.whenReady();
  const extensionDir = prepareExtension(root, process.env);
  // A normal foreground app (Dock icon, Cmd+Tab): explicit, not just "never called dock.hide()".
  if (process.platform === "darwin") app.setActivationPolicy("regular");
  // A real Edit menu, so Cmd+C/Cmd+V/Cmd+Z work in the command box like any other Mac app.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }]));

  // The renderer captures the mic; ask up front (without blocking startup on the dialog) so the
  // first mic-button press is not itself the permission prompt.
  if (process.platform === "darwin") {
    const status = systemPreferences.getMediaAccessStatus("microphone");
    console.log(`microphone access: ${status}`);
    // Permission is requested when the user actually starts a conversation, never during setup.
  }

  const decider = createDecider();
  const stt = selectSttProvider(process.env, { appleBin: path.join(root, "native", "jev-speech", "jev-speech") });
  const sttListener = selectWakeListener(process.env, { appleBin: path.join(root, "native", "jev-speech", "jev-speech") });
  console.log(describeWake(sttListener, stt));
  console.log(describeStt(stt));
  const voice = createVoice(process.env, undefined, new MuteSwitch(readState().muted === true));
  console.log(voice.description);
  // Jarvis's voice follows the Mac's output setting; name it, so "silent headset" is diagnosable.
  const outputDevice = deviceReader(path.join(root, "native", "jev-audio-out", "jev-audio-out"));
  void outputDevice().then((d) => console.log(`voice device: ${d ?? "unknown (jev-audio-out not built)"}`));
  const computer = selectComputer();
  // the user's Chrome: registered up front, driven while the bridge extension is connected
  const bridge = new RemoteExecutor({
    onReady: (ready) => {
      console.log(ready ? "chrome: bridge connected — acting in your Chrome" : "chrome: bridge disconnected — pages open in your default browser");
      companion.hub.followDefault();
    },
  });
  // "front": the Mac app in front (through cua-driver) or, when a browser is in front, the bridge
  const mac = selectMac({ ownPids: () => [process.pid] });
  // the brain's hands are the same executors the fast lane uses — no second browser, no second driver
  const cofounder = selectCofounder();
  const brain = createBrain(process.env, { spoken: !!voice.speaker, hands: { mac, chrome: bridge, chromeBackground: bridge.jevTab(), computer, box: selectBrowserBox(), cofounder, orgo: selectOrgo() } });
  const assistant = createAssistantRuntime({ env: process.env, hands: { mac, chrome: bridge, chromeBackground: bridge.jevTab(), computer, cofounder, orgo: selectOrgo() }, chromeReady: () => bridge.ready, computerReady: () => mac?.ready ?? false });
  const companion = createCompanion({
    phone: { home: process.env.JEV_HOME!, port: process.env.JEV_PHONE_PORT ? Number(process.env.JEV_PHONE_PORT) : undefined },
    assistant,
    decider,
    token: process.env.JEV_TOKEN,
    clientDir: path.join(root, "dist", "client"),
    defaultSession: process.env.JEV_DEFAULT_SESSION,
    stt,
    sttListener,
    speaker: voice.speaker,
    voiceDescription: voice.description,
    outputDevice,
    gate: voice.gate,
    cofounder,
    mute: voice.mute,
    brain,
    computer,
    bridge,
    browserView: browserViewUrl(),
  });
  // Fire and forget: every scripted line is rendered to ~/.jev/tts-cache in the background so the
  // first spoken reply is instant. A failure here logs and changes nothing else.
  voice.warm((l) => console.log(l));
  wireCofounder(cofounder, companion.announce, (l) => console.log(l));
  if (brain) void brain.health().then((h) => console.log(h.ok ? `brain: ${brain.name} (${h.detail})` : `brain: ${brain.name} not reachable — ${h.detail}`));
  else console.log("brain: none (set OPENROUTER_API_KEY)");
  const port = await companion.listen(PORT);
  baseUrl = `http://127.0.0.1:${port}`;
  void assistant.recoverVoice().catch(() => {});
  void assistant.recoverCloud().catch(() => {});
  const voiceProcess = startVoiceProcess(root, baseUrl, assistant);
  app.on("before-quit", () => voiceProcess.stop());
  assistant.queue.start();
  // The co-founder's way in to Jarvis: Tailscale only, its own token, Jarvis's own approvals.
  const cofounderAccess = await startCofounderAccess({
    env: process.env,
    session: () => (companion.hub.defaultId ? (companion.hub.get(companion.hub.defaultId) ?? null) : null),
    look: () => lookAtMac(mac),
    paused: () => companion.hub.paused,
    announce: companion.announce,
    log: (l) => console.log(l),
  });
  // Chrome not connected: open pages visibly in his default browser rather than in a hidden one
  const system = new SystemBrowser();

  const front = mac ? new FrontExecutor({ mac, chrome: bridge, fallback: system }) : null;
  if (front) companion.register(front);
  companion.register(bridge);
  if (!front) companion.register(system);
  if (front) void front.start().then(() => console.log(mac!.ready ? "mac: cua-driver ready — acting in the app in front" : "mac: cua-driver not answering — Mac apps off (run hermes computer-use doctor)"));
  else console.log("mac: off");

  // Only our own renderer gets the microphone.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const ok = permission === "media" && new URL(wc.getURL()).origin === baseUrl;
    console.log(`permission request: ${permission} ${JSON.stringify(details)} → ${ok}`);
    callback(ok);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
    const ok = permission === "media" && origin === baseUrl;
    return ok;
  });

  win = createWindow();
  app.on("activate", () => showPanel());
  tray = new Tray(icon("idle"));
  setPaused = (paused) => companion.hub.setPaused(paused);
  companion.hub.onPause((paused) => {
    panel = onPaused(panel, paused);
    refreshTray();
  });
  buildTrayMenu = () =>
    Menu.buildFromTemplate([
      { label: `Show Jarvis (${HOTKEY})`, click: () => runHotkey() },
      ...(talkStatus === "off"
        ? []
        : [
            {
              label:
                talkStatus === "ready"
                  ? `Talk: hold ${comboLabel(TALK_KEYS)} (tap = hands-free)`
                  : talkStatus === "needs-permission"
                    ? `${comboLabel(TALK_KEYS)} needs Input Monitoring — open Settings`
                    : `${comboLabel(TALK_KEYS)} talk key is off (${talkStatus})`,
              enabled: talkStatus === "needs-permission",
              click: () => void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"),
            },
          ]),
      { label: panel.paused ? "Resume Jarvis" : "Pause Jarvis (off: hears, says and does nothing)", click: () => setPaused(!panel.paused) },
      { type: "separator" },
      { label: `Jarvis: ${decider.enabled ? decider.model : "heuristics"}`, enabled: false },
      { type: "separator" },
      ...(app.isPackaged
        ? [
            {
              label: "Open Jarvis at Login",
              type: "checkbox" as const,
              checked: app.getLoginItemSettings().openAtLogin,
              click: () => app.setLoginItemSettings({ openAtLogin: !app.getLoginItemSettings().openAtLogin }),
            },
            { type: "separator" as const },
          ]
        : []),
      { label: "Quit Jarvis", click: () => app.quit() },
    ]);
  tray.on("click", () => {
    const current = win;
    if (quitting) return;
    if (!current || current.isDestroyed()) { showPanel(); return; }
    if (current.isVisible()) current.hide(); else showPanel();
  });
  refreshTray();

  ipcMain.on("jev:busy", (_e, busy: boolean) => {
    panel = onRendererBusy(panel, !!busy);
    refreshTray();
  });
  ipcMain.on("jev:speaking", (_e, speaking: boolean) => {
    panel = onRendererSpeaking(panel, !!speaking);
  });
  ipcMain.on("jev:hide", () => runEscape());
  ipcMain.handle("jev:is-visible", () => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
  const ownSettings = (event: Electron.IpcMainInvokeEvent) => {
    if (!win || event.sender !== win.webContents || event.senderFrame?.url !== `${baseUrl}/?mode=desktop`) throw new Error("Settings are available only in the Jarvis desktop panel");
  };
  ipcMain.handle("jev:connections:get", (event) => { ownSettings(event); return connectionSettings(process.env.JEV_HOME!); });
  ipcMain.handle("jev:window:expanded", (event) => { ownSettings(event); return (win?.getBounds().width ?? 0) >= 900; });
  ipcMain.handle("jev:mac-setup", async (event) => {
    ownSettings(event);
    await shell.openPath("/Applications/CuaDriver.app");
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  });
  ipcMain.handle("jev:window:toggle", (event) => {
    ownSettings(event); if (!win) return false;
    const wide = win.getBounds().width < 900; const area = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setSize(Math.min(wide ? 1080 : 440, area.width - 32), Math.min(wide ? 800 : 720, area.height - 32)); placeBottomRight(win); return wide;
  });
  ipcMain.handle("jev:connections:save", (event, update: unknown) => { ownSettings(event); return saveConnections(process.env.JEV_HOME!, update); });
  ipcMain.handle("jev:restart", (event) => {
    ownSettings(event);
    if (!assistant.canRestart() || panel.busy) throw new Error("Pause or finish running tasks and end the voice conversation before restarting");
    setTimeout(() => { app.relaunch(); app.quit(); }, 250);
  });
  ipcMain.handle("jev:settings", () => shell.showItemInFolder(path.join(process.env.JEV_HOME!, ".env")));
  ipcMain.handle("jev:extension", () => shell.openPath(extensionDir));

  if (TALK_KEYS !== "off") {
    const keys = startTalkKeys({
      bin: path.join(root, "native", "jev-keys", "jev-keys"),
      combo: TALK_KEYS,
      onEvent: (event) => {
        const r = onTalkKey(talk, event, Date.now(), !!panel.speaking);
        talk = r.state;
        for (const e of r.effects) {
          if (e === "hush") applyEffects(["hush"]);
          else win?.webContents.send("jev:talk", e);
        }
      },
      onStatus: (status, detail) => {
        if (status === talkStatus) return;
        talkStatus = status;
        const label = comboLabel(TALK_KEYS);
        console.log(
          status === "ready"
            ? `talk key: ${label} — hold to talk, tap for hands-free`
            : status === "needs-permission"
              ? `talk key: ${label} needs Input Monitoring for jev-keys (System Settings → Privacy & Security → Input Monitoring)`
              : `talk key: off (${status}${detail ? `: ${detail}` : ""})`,
        );
        refreshTray();
      },
    });
    app.on("before-quit", () => keys.stop());
  }

  if (!globalShortcut.register(HOTKEY, () => runHotkey())) {
    console.error(`Could not register the ${HOTKEY} hotkey; use the tray menu.`);
  }
  showPanel();
  console.log(`Jarvis desktop → ${baseUrl}  hotkey ${HOTKEY}${envKeys.length ? `  (.env: ${envKeys.length} keys)` : ""}`);

  let shutdownStarted = false;
  app.on("before-quit", (event) => {
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    quitting = true;
    // Ignore late tray/renderer events before asynchronous cleanup destroys native objects.
    if (tray && !tray.isDestroyed()) { tray.removeAllListeners(); tray.destroy(); }
    tray = null;
    globalShortcut.unregisterAll();
    voiceProcess.stop();
    const deadline = setTimeout(() => app.exit(0), 8000);
    deadline.unref();
    // A second app.quit() can leave macOS's original quit sequence half-finished.
    // Cleanup is complete here; exit explicitly so the single-instance lock is released.
    void Promise.allSettled([companion.close(), cofounderAccess?.close()]).finally(() => { clearTimeout(deadline); app.exit(0); });
  });
}

app.on("window-all-closed", () => {
  /* stay in the tray */
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => app.quit());

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  app.exit(1);
});
