/** The Mac's frontmost app as a surface, through Cua's `cua-driver` (the same daemon Hermes'
 *  computer_use tool drives, so the Accessibility and Screen Recording grants belong to
 *  CuaDriver.app and never to us). One call per verb: list_windows to find the window the user
 *  is in, get_window_state for its accessibility tree, click / type_text / press_key / scroll
 *  by element token. Actions go through the accessibility path by default — no cursor moves,
 *  no focus stealing — so the user keeps typing while Jev works. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Action } from "../../core/actions.js";
import { MAX_ELEMENTS, type PageSnapshot } from "../../core/elements.js";
import type { Executor, ExecutorCapabilities } from "../../core/executor.js";
import { type AxElement, BROWSER_APPS, type MacWindow, appUrl, appWindow, driverKey, findText, frontWindow, isStaleTokenError, macSnapshot, macText, menuBar, pixelFor, pointFor } from "../../core/mac.js";

/** One driver round trip: tool name + JSON arguments -> parsed JSON result. */
export type Driver = (tool: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface MacExecutorOptions {
  pictureWindow?: () => MacWindow | null;
  /** A remote human takes over the pictured window; desktop/agent actions keep their background ladder. */
  manualDelivery?: "foreground";
  driver?: Driver;
  /** Processes whose windows are never the user's target (the floating panel itself). */
  ownPids?: () => number[];
  /** Accessibility elements walked per snapshot; Electron apps have thousands. */
  maxElements?: number;
  maxDepth?: number;
  /** `snapshot()` reuses the last tree for this long (the loop snapshots before every step). */
  snapshotTtlMs?: number;
  timeoutMs?: number;
  /** Launch the driver daemon when it is not answering (`open -g -a CuaDriver --args serve`). */
  launchDaemon?: () => Promise<void>;
  /** Open a URL in the default browser (tests stub it). */
  open?: (url: string) => Promise<void>;
  /** The frontmost application's pid — the app the keyboard belongs to (default: `lsappinfo front`). */
  frontPid?: () => Promise<number | null>;
  /** Floor between real screenshot captures; the hub polls every ~700 ms (fine for a cheap DOM
   *  read) but a Mac capture is a driver round trip + a `sips` conversion, so it is throttled
   *  independently and served from cache in between. */
  screenshotMinIntervalMs?: number;
  now?: () => number;
}

export const DRIVER_BIN = process.env.CUA_DRIVER ?? [join(process.env.HOME ?? "", ".local/bin/cua-driver"), "/Applications/CuaDriver.app/Contents/MacOS/cua-driver"].find(existsSync) ?? join(process.env.HOME ?? "", ".local/bin/cua-driver");

export const NOT_AVAILABLE = "The Mac isn't reachable: cua-driver is not answering (run `hermes computer-use doctor`)";
export const NO_WINDOW = "Nothing is in front to act on: bring the app forward first";

/** One read of an app for the brain: what can be acted on (ids), what the window says, its menus. */
export interface AppRead {
  snapshot: PageSnapshot;
  text: string;
  menus: string[];
  app: string;
}

/** Elements walked per brain read. Deeper and wider than the fast lane's: message text sits under
 *  the web content of Electron apps, and the menu bar no longer takes the slots. */
const BRAIN_MAX_ELEMENTS = 900;
const BRAIN_MAX_DEPTH = 24;

/** How long after Jev last worked in an app the panel keeps showing that app's window rather than
 *  the one in front. Long enough to watch a slow run; short enough that the panel goes back to
 *  "your screen" once she is done. */
export const FOLLOW_MS = 90_000;

interface Held {
  window: MacWindow;
  snapshotId: string | null;
  tokens: Map<string, AxElement>;
  /** The read's whole tree, for clicking a line of text that has no id (see clickText). */
  elements?: AxElement[];
  snapshot: PageSnapshot;
  at: number;
  /** Set after any action: the tree must be walked again before the next decision. */
  stale: boolean;
}

/** `cua-driver call <tool> '<json>'`: the CLI talks to the daemon over its socket and prints the
 *  structured result as JSON. ~30 ms of process overhead per call. */
export function cliDriver(bin = DRIVER_BIN, timeoutMs = 30_000): Driver {
  return (tool, args = {}) =>
    new Promise((resolve, reject) => {
      execFile(bin, ["call", tool, JSON.stringify(args)], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        const text = String(stdout ?? "").trim();
        if (err && !text) return reject(new Error(String(stderr || err.message).trim()));
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          // the driver prints a bare sentence for refusals ("permissions_pending: …")
          return reject(new Error(text || String(stderr || err?.message || "no output").trim()));
        }
        if (parsed && typeof parsed === "object" && "error" in parsed && (parsed as { error?: unknown }).error) {
          const e = (parsed as { error: unknown }).error;
          return reject(new Error(typeof e === "string" ? e : JSON.stringify(e)));
        }
        resolve(parsed);
      });
    });
}

/** The Mac surface for this host: macOS, not switched off, driver installed. */
export function selectMac(opts: Omit<MacExecutorOptions, "launchDaemon"> = {}, env: NodeJS.ProcessEnv = process.env, platform = process.platform): MacExecutor | null {
  if (platform !== "darwin" || env.JEV_MAC === "off") return null;
  if (!existsSync(env.CUA_DRIVER ?? DRIVER_BIN)) return null;
  return new MacExecutor({ launchDaemon, ...opts });
}

export function launchDaemon(): Promise<void> {
  return new Promise((resolve) => execFile("open", ["-g", "-a", "CuaDriver", "--args", "serve"], () => setTimeout(resolve, 1500)));
}

export class MacExecutor implements Executor {
  private readonly fileId = `${process.pid}-${randomUUID()}`;
  readonly kind = "mac" as const;
  readonly capabilities: ExecutorCapabilities = { screenshot: true, viewport: false, clickAt: false, read: false };
  readonly viewport = { width: 1280, height: 800 };
  private readonly driver: Driver;
  private held: Held | null = null;
  private available = false;
  private readonly changeListeners = new Set<() => void>();
  private readonly now: () => number;
  private lastShot: { at: number; buf: Uint8Array | null } | null = null;
  /** The window last pictured for the panel: what the user's own clicks and keys land on. */
  private shown: MacWindow | null = null;
  /** When Jev last read or acted in an app (see FOLLOW_MS). */
  private workedAt = Number.NEGATIVE_INFINITY;
  /** How keys and scrolls are delivered. The fast lane acts on the window the user is looking at
   *  ("foreground"); the brain works in apps behind his back ("background") and only fronts a
   *  window for the one case the driver refuses in the background. */
  private delivery: "foreground" | "background" = "foreground";
  /** Set when a background action had to bring the window forward after all. */
  private fronted = false;
  private shotInFlight: Promise<Uint8Array | null> | null = null;

  constructor(
    private readonly opts: MacExecutorOptions = {},
    readonly id = "mac",
  ) {
    this.driver = opts.driver ?? cliDriver(DRIVER_BIN, opts.timeoutMs);
    this.now = opts.now ?? Date.now;
  }

  /** The driver answered and holds its permissions. Re-checked by start() and after failures. */
  get ready(): boolean {
    return this.available;
  }

  get url(): string {
    return this.held ? appUrl(this.held.window.app_name) : "app://";
  }

  /** The window the last snapshot was taken of. */
  get window(): MacWindow | null {
    return this.held?.window ?? null;
  }

  async start(): Promise<void> {
    this.available = await this.probe();
    if (!this.available && this.opts.launchDaemon) {
      await this.opts.launchDaemon();
      this.available = await this.probe();
    }
  }

  /** `check_permissions` is the one call that answers only when the daemon is up *and* trusted. */
  async probe(): Promise<boolean> {
    try {
      const r = (await this.driver("check_permissions", {})) as { accessibility?: boolean };
      return r?.accessibility === true;
    } catch {
      return false;
    }
  }

  async title(): Promise<string> {
    return this.held?.snapshot.title ?? "";
  }

  /** Which app is in front right now. `lsappinfo front` (~10 ms, no TCC) names the frontmost
   *  application; the window comes from list_windows. Null when nothing ordinary is in front. */
  async front(): Promise<MacWindow | null> {
    const [r, pid] = await Promise.all([this.call("list_windows", {}) as Promise<{ windows?: MacWindow[] }>, this.frontPid()]);
    return frontWindow(r.windows ?? [], this.opts.ownPids?.() ?? [], pid);
  }

  private frontPid(): Promise<number | null> {
    if (this.opts.frontPid) return this.opts.frontPid();
    return new Promise((resolve) =>
      execFile("/bin/sh", ["-c", 'lsappinfo info -only pid "$(lsappinfo front)"'], { timeout: 3000 }, (_e, out) => {
        const m = /"pid"\s*=\s*(\d+)/.exec(String(out));
        resolve(m ? Number(m[1]) : null);
      }),
    );
  }

  /** Is a browser the front app? The hub then prefers the Chrome bridge for this turn. */
  async browserInFront(): Promise<boolean> {
    const w = await this.front();
    return w !== null && BROWSER_APPS.has(w.app_name);
  }

  /** `win`: a window the caller already looked up this turn (saves the list_windows call). */
  async snapshot(win?: MacWindow | null): Promise<PageSnapshot> {
    const ttl = this.opts.snapshotTtlMs ?? 1200;
    if (this.held && !this.held.stale && this.now() - this.held.at < ttl && (!win || win.window_id === this.held.window.window_id)) return this.held.snapshot;
    if (win === undefined) win = await this.front();
    if (!win) {
      this.held = null;
      return { url: "app://", title: "", elements: [] };
    }
    const r = (await this.call("get_window_state", {
      pid: win.pid,
      window_id: win.window_id,
      include_screenshot: false,
      max_elements: this.opts.maxElements ?? 600,
      max_depth: this.opts.maxDepth ?? 16,
    })) as { snapshot_id?: string; elements?: AxElement[]; window_title?: string };
    const { snapshot, tokens } = macSnapshot({ ...win, title: r.window_title || win.title }, r.elements ?? [], MAX_ELEMENTS);
    this.held = { window: win, snapshotId: r.snapshot_id ?? null, tokens, snapshot, at: this.now(), stale: false };
    return snapshot;
  }

  async screenshot(): Promise<Uint8Array | null> {
    const floor = this.opts.screenshotMinIntervalMs ?? 1500;
    if (this.lastShot && this.now() - this.lastShot.at < floor) return this.lastShot.buf;
    if (this.shotInFlight) return this.shotInFlight; // the hub polls faster than a capture takes: share it
    this.shotInFlight = this.captureScreenshot().finally(() => {
      this.shotInFlight = null;
    });
    return this.shotInFlight;
  }

  /** Jev worked in an app within FOLLOW_MS. */
  get working(): boolean {
    return this.now() - this.workedAt < FOLLOW_MS;
  }

  /** Jev moved on to another surface (Chrome, a connector): stop picturing the app she last read.
   *  The window stays held, so a mac_act that follows still knows where it acts. */
  release(): void {
    if (this.workedAt === Number.NEGATIVE_INFINITY) return;
    this.workedAt = Number.NEGATIVE_INFINITY;
    this.lastShot = null;
    for (const cb of this.changeListeners) cb();
  }

  /** Why the last picture is missing, for the panel. */
  frameProblem: string | null = null;

  /** What the last frame shows, for the panel's header. */
  async frameInfo(): Promise<{ url: string; title: string }> {
    const w = this.shown;
    return w ? { url: appUrl(w.app_name), title: w.title || w.app_name } : { url: this.url, title: await this.title() };
  }

  private async captureScreenshot(): Promise<Uint8Array | null> {
    // While Jev is working in an app, picture THAT window — Slack behind Chrome is the whole point
    // of watching her. Otherwise, whatever is in front — and never an old window as a stand-in:
    // live 2026-09-28 the pane sat on a Finder window Jev had read earlier, long after she moved
    // to Chrome, because "nothing in front" fell back to it with no time limit.
    const held = this.held?.window ?? null;
    let problem: string | null = null;
    const win =
      this.opts.pictureWindow?.() ||
      (this.working && held) ||
      (await this.front().catch((err) => {
        problem = `Couldn't see which window is in front (${err instanceof Error ? err.message : String(err)})`;
        return null;
      }));
    this.shown = win;
    if (!win) {
      this.frameProblem = problem ?? "Nothing in front but Jev's own windows";
      this.lastShot = { at: this.now(), buf: null };
      return null;
    }
    const png = join(tmpdir(), `jev-mac-${this.fileId}.png`);
    const jpg = join(tmpdir(), `jev-mac-${this.fileId}.jpg`);
    let buf: Uint8Array | null = null;
    try {
      await this.call("get_window_state", { pid: win.pid, window_id: win.window_id, include_accessibility_tree: false, max_dimension: 1280, screenshot_out_file: png });
      // the driver writes PNG; the UIs expect JPEG frames — sips ships with macOS
      await new Promise<void>((resolve, reject) => execFile("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", png, "--out", jpg], (err) => (err ? reject(err) : resolve())));
      const file = await readFile(jpg);
      buf = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    } catch {
      buf = null;
    } finally {
      await Promise.all([rm(png, { force: true }), rm(jpg, { force: true })]).catch(() => {});
    }
    this.frameProblem = buf ? null : `Couldn't take a picture of ${win.app_name}`;
    this.lastShot = { at: this.now(), buf };
    return buf;
  }

  async execute(action: Action): Promise<string> {
    switch (action.kind) {
      case "navigate":
        // a URL said while a Mac app is in front: the default browser, brought forward
        await this.open(action.url);
        this.invalidate();
        return `Opened ${action.url} in your browser`;
      case "search":
        await this.open(action.url);
        this.invalidate();
        return `Searched for "${action.query}" in your browser`;
      case "click": {
        const { pid, element } = this.locate(action.elementId, action.label);
        await this.byToken(action.label, () => this.call("click", { pid, element_token: element.element_token, action: "press" }));
        this.invalidate();
        return `Clicked ${action.label}`;
      }
      case "type": {
        // background: writing to an element (by token) or to whatever already has the caret (no
        // token) both work without fronting the window — confirmed live. Only the trailing Enter
        // needs `target()`'s brief foreground (background press_key returned "candidates" /
        // never fired against TextEdit). Fronting for the text insertion too was the M5 bug: two
        // foreground front/restore cycles per typed instruction, back to back on a fast lane
        // sequence, could restore focus to the wrong app between one instruction and the next —
        // three queued "type … and press enter" commands landed only the first.
        if (action.elementId) {
          const { pid, element } = this.locate(action.elementId, action.label ?? action.elementId);
          await this.byToken(action.label ?? action.elementId, () => this.call("type_text", { pid, element_token: element.element_token, text: action.text }));
        } else {
          await this.call("type_text", { pid: this.pidFor(), text: action.text });
        }
        if (action.submit) await this.input("press_key", { key: "return" });
        this.invalidate();
        return `Typed "${action.text}"${action.label ? ` into ${action.label}` : ""}${action.submit ? " and pressed Enter" : ""}`;
      }
      case "press": {
        const { key, modifiers } = driverKey(action.key);
        await this.input("press_key", { key, ...(modifiers.length ? { modifiers } : {}) });
        this.invalidate();
        return `Pressed ${action.key}`;
      }
      case "scroll": {
        const toEdge = action.direction === "top" || action.direction === "bottom";
        await this.input("scroll", { direction: action.direction === "top" ? "up" : action.direction === "bottom" ? "down" : action.direction, by: "page", amount: toEdge ? 20 : 3 });
        this.invalidate();
        return toEdge ? `Scrolled to ${action.direction}` : `Scrolled ${action.direction}`;
      }
      case "back":
        await this.input("press_key", { key: "left", modifiers: ["cmd"] });
        this.invalidate();
        return "Went back";
      case "forward":
        await this.input("press_key", { key: "right", modifiers: ["cmd"] });
        this.invalidate();
        return "Went forward";
      case "reload":
        await this.input("press_key", { key: "r", modifiers: ["cmd"] });
        this.invalidate();
        return "Reloaded";
      case "click_at":
        throw new Error("Clicking by coordinates isn't available on the Mac surface");
      case "open_app":
      case "open_path":
        throw new Error("Opening apps and files is the computer lane's job, not the surface's");
      case "stop":
      case "none":
        return "";
    }
  }

  async setViewport(): Promise<boolean> {
    return false; // the user's windows are theirs
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  async close(): Promise<void> {
    this.held = null;
  }

  /** The last snapshot is stale after any action; the next snapshot() walks the tree again. */
  private invalidate(): void {
    if (this.held) this.held.stale = true;
    this.workedAt = this.now();
    this.lastShot = null; // the next frame is a fresh picture, not the one from before the action
    for (const cb of this.changeListeners) cb();
  }

  private pidFor(): number {
    if (!this.held) throw new Error(NO_WINDOW);
    return this.held.window.pid;
  }

  /** Keys and scrolls go to the exact window, delivered as real input while it is briefly
   *  fronted: the window is the one in front anyway, and background posts to a Cocoa text
   *  view are silently dropped (the driver answers with a list of candidate windows). */
  private target(mode: "foreground" | "background" = this.delivery): { pid: number; window_id: number; delivery_mode: "foreground" | "background" } {
    if (!this.held) throw new Error(NO_WINDOW);
    return { pid: this.held.window.pid, window_id: this.held.window.window_id, delivery_mode: mode };
  }

  /** A key press or scroll that must land. In the background the driver can refuse (an error) or
   *  answer with the windows it could have meant ("candidates") without firing — either way it is
   *  retried once in the foreground, and the brain is told the window came forward. */
  private async input(tool: "press_key" | "scroll", args: Record<string, unknown>): Promise<void> {
    if (this.delivery === "foreground") {
      await this.call(tool, { ...this.target(), ...args });
      return;
    }
    let landed = false;
    try {
      const r = (await this.call(tool, { ...this.target("background"), ...args })) as Record<string, unknown> | null;
      landed = !(r && typeof r === "object" && "candidates" in r);
    } catch (err) {
      if (err instanceof Error && err.message === NOT_AVAILABLE) throw err;
    }
    if (landed) return;
    this.fronted = true;
    await this.call(tool, { ...this.target("foreground"), ...args });
  }

  // ---- the brain's side: named apps, in the background -------------------------------------

  /** Read an app by name without bringing it forward (or the app in front when `app` is null). */
  async readApp(app: string | null, opts: { query?: string } = {}): Promise<AppRead> {
    let win: MacWindow | null;
    if (app) {
      const r = (await this.call("list_windows", {})) as { windows?: MacWindow[] };
      win = appWindow(r.windows ?? [], app, this.opts.ownPids?.() ?? []);
      if (!win) throw new Error(`${app} isn't open. Open it first (mac_act open_app), then read it.`);
    } else {
      win = await this.front();
      if (!win) throw new Error(NO_WINDOW);
    }
    const r = (await this.call("get_window_state", {
      pid: win.pid,
      window_id: win.window_id,
      include_screenshot: false,
      max_elements: BRAIN_MAX_ELEMENTS,
      max_depth: BRAIN_MAX_DEPTH,
      ...(opts.query ? { query: opts.query } : {}),
    })) as { snapshot_id?: string; elements?: AxElement[]; window_title?: string };
    const elements = r.elements ?? [];
    const titled = { ...win, title: r.window_title || win.title };
    const { snapshot, tokens } = macSnapshot(titled, elements, MAX_ELEMENTS, { skipMenus: true });
    this.held = { window: titled, snapshotId: r.snapshot_id ?? null, tokens, elements, snapshot, at: this.now(), stale: false };
    this.workedAt = this.now();
    return { snapshot, text: macText(elements), menus: menuBar(elements), app: win.app_name };
  }

  /** The window the last read was of, re-read (what the brain sees after it acts). */
  async reread(): Promise<AppRead> {
    return this.readApp(this.held?.window.app_name ?? null);
  }

  /** Act in the app of the last read, in the background. */
  async actInApp(action: Action): Promise<string> {
    this.delivery = "background";
    this.fronted = false;
    try {
      const done = await this.execute(action);
      const app = this.held?.window.app_name;
      return this.fronted && app ? `${done} (I had to bring ${app} forward for a moment)` : done;
    } finally {
      this.delivery = "foreground";
    }
  }

  /** The driver's click space for a window: its own screenshot's width, and the window's bounds. */
  private async measure(win: MacWindow): Promise<{ screenshotWidth: number; bounds: MacWindow["bounds"] }> {
    const shot = join(tmpdir(), `jev-click-${this.fileId}.png`);
    const r = (await this.call("get_window_state", { pid: win.pid, window_id: win.window_id, include_accessibility_tree: false, screenshot_out_file: shot })) as {
      screenshot_width?: number;
      window_bounds?: MacWindow["bounds"];
    };
    await rm(shot, { force: true });
    const bounds = r.window_bounds?.height ? r.window_bounds : win.bounds;
    if (!r.screenshot_width || !bounds?.width) throw new Error(`Couldn't measure the ${win.app_name} window.`);
    return { screenshotWidth: r.screenshot_width, bounds };
  }

  // ---- the user's own hands, on the panel's picture ------------------------------------------
  // No decision and no approval: it is him clicking and typing, just through the panel. Delivered
  // in the background, to the window the picture shows, so the app he is actually in stays put.

  private shownWindow(): MacWindow {
    if (!this.shown) throw new Error("Nothing on screen yet — wait for the picture.");
    return this.shown;
  }

  async inputClick(fx: number, fy: number): Promise<string> {
    const win = this.shownWindow();
    const m = await this.measure(win);
    const at = pointFor(fx, fy, m.bounds, m.screenshotWidth);
    if (this.opts.manualDelivery === "foreground") await this.call("click", { pid: win.pid, window_id: win.window_id, ...at, delivery_mode: "foreground" });
    else await this.deliver("click", win, at);
    this.invalidate();
    return `Clicked in ${win.app_name}`;
  }

  async inputText(text: string): Promise<string> {
    const win = this.shownWindow();
    await this.call("type_text", { pid: win.pid, window_id: win.window_id, text, ...(this.opts.manualDelivery ? { delivery_mode: this.opts.manualDelivery } : {}) });
    this.invalidate();
    return `Typed in ${win.app_name}`;
  }

  async inputKey(key: string): Promise<string> {
    const win = this.shownWindow();
    const k = driverKey(key);
    const args = { key: k.key, ...(k.modifiers.length ? { modifiers: k.modifiers } : {}) };
    if (this.opts.manualDelivery === "foreground") await this.call("press_key", { pid: win.pid, window_id: win.window_id, ...args, delivery_mode: "foreground" });
    else await this.deliver("press_key", win, args);
    this.invalidate();
    return `Pressed ${key} in ${win.app_name}`;
  }

  /** Background first; the driver can refuse or answer with candidate windows without firing, and
   *  then the one foreground retry is the only way it lands. */
  private async deliver(tool: "click" | "press_key", win: MacWindow, args: Record<string, unknown>): Promise<void> {
    const where = { pid: win.pid, window_id: win.window_id };
    try {
      const r = (await this.call(tool, { ...where, ...args, delivery_mode: "background" })) as Record<string, unknown> | null;
      if (!(r && typeof r === "object" && "candidates" in r)) return;
    } catch (err) {
      if (err instanceof Error && err.message === NOT_AVAILABLE) throw err;
    }
    await this.call(tool, { ...where, ...args, delivery_mode: "foreground" });
  }

  /** Click a line of text from the last read that has no id — a row in Slack's DM list is only
   *  static text inside a list, with nothing to press. The click is posted to the window at that
   *  text's centre, in the background: no cursor move, no focus (the driver resolves the point back
   *  to the element under it). Grounded, not blind: the point comes from the text's own frame in the
   *  accessibility tree, never from a guess at the picture. */
  async clickText(text: string): Promise<string> {
    const held = this.held;
    this.fronted = false;
    if (!held?.elements) throw new Error("Read the app first, then click text from that read.");
    const hit = findText(held.elements, text);
    if (!hit?.frame) throw new Error(`No text "${text}" in the last read — read again and use text shown under "Text on screen".`);
    const name = (hit.value || hit.label || text).trim();
    // The click space is the driver's own screenshot of the window, whose size it reports here.
    const shot = join(tmpdir(), `jev-click-${this.fileId}.png`);
    const r = (await this.call("get_window_state", { pid: held.window.pid, window_id: held.window.window_id, include_accessibility_tree: false, screenshot_out_file: shot })) as {
      screenshot_width?: number;
      window_bounds?: { x: number; y: number; width: number };
    };
    await rm(shot, { force: true });
    const bounds = r.window_bounds ?? held.window.bounds;
    if (!r.screenshot_width || !bounds?.width) throw new Error(`Couldn't place a click on "${name}" — the window could not be measured.`);
    const at = pixelFor(hit.frame, bounds, r.screenshot_width);
    try {
      await this.call("click", { pid: held.window.pid, window_id: held.window.window_id, ...at, delivery_mode: "background" });
    } catch (err) {
      if (err instanceof Error && err.message === NOT_AVAILABLE) throw err;
      this.fronted = true;
      await this.call("click", { pid: held.window.pid, window_id: held.window.window_id, ...at, delivery_mode: "foreground" });
    }
    this.invalidate();
    const done = `Clicked "${name}"`;
    return this.fronted ? `${done} (I had to bring ${held.window.app_name} forward for a moment)` : done;
  }

  /** An app-menu path, e.g. ["File", "New"], invoked through accessibility. Fails closed on a
   *  missing or disabled item — no guessing at a menu by position. */
  async menu(path: string[]): Promise<string> {
    if (!this.held) throw new Error("Read the app first, then choose from its menus.");
    await this.call("invoke_menu", { pid: this.held.window.pid, window_id: this.held.window.window_id, path });
    this.invalidate();
    return `Chose ${path.join(" › ")} in ${this.held.window.app_name}`;
  }

  /** Set a field, popup, slider or date directly — no clicking, no focus. */
  async setValue(elementId: string, label: string, value: string): Promise<string> {
    const { pid, element } = this.locate(elementId, label);
    await this.byToken(label, () => this.call("set_value", { pid, window_id: this.held!.window.window_id, element_token: element.element_token, value }));
    this.invalidate();
    return `Set ${label} to "${value}"`;
  }

  /** Open an app WITHOUT bringing it forward: the brain reads and acts in it from behind. */
  async launch(name: string): Promise<string> {
    const r = (await this.call("launch_app", { name })) as { name?: string } | null;
    return `Opened ${r?.name ?? name} in the background — the user's screen is unchanged. Read it with mac_read app:"${r?.name ?? name}".`;
  }

  /** The window the brain is working in, as a PNG at `file` — its record of what each action left
   *  behind. (Not the driver's own recorder: that belongs to the connection that started it, and Jev
   *  makes one short CLI call per action, so it closed as soon as it opened.) */
  async captureTo(file: string): Promise<void> {
    if (!this.held) return;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await this.call("get_window_state", { pid: this.held.window.pid, window_id: this.held.window.window_id, include_accessibility_tree: false, max_dimension: 1280, screenshot_out_file: file });
  }

  private locate(elementId: string, label: string): { pid: number; element: AxElement } {
    const element = this.held?.tokens.get(elementId);
    if (!this.held || !element?.element_token) throw new Error(`${label} is no longer on the page`);
    return { pid: this.held.window.pid, element };
  }

  /** The driver refuses tokens from a superseded snapshot: report that in the words every
   *  executor uses, so the loop re-snapshots and retries the way it does for web pages. */
  private async byToken<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isStaleTokenError(msg)) throw new Error(`${label} is no longer on the page`);
      throw err;
    }
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      const r = await this.driver(tool, args);
      this.available = true;
      return r;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not running|Start it first|ECONNREFUSED|ENOENT|permissions_pending|daemon/i.test(msg)) {
        this.available = false;
        throw new Error(NOT_AVAILABLE);
      }
      throw err;
    }
  }

  private open(url: string): Promise<void> {
    return this.opts.open ? this.opts.open(url) : new Promise((resolve, reject) => execFile("open", [url], (err) => (err ? reject(err) : resolve())));
  }
}
