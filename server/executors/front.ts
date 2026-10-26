/** "What's in front": one surface that stands for whatever the user is looking at. A browser
 *  in front means the Chrome bridge (the tab, with its DOM); any other app means the Mac
 *  executor (its accessibility tree); nothing usable in front falls back to the bridge, then
 *  to the built-in browser. The choice is made once per snapshot and held for the actions
 *  that follow, so element ids always belong to the surface they came from. */
import type { Action } from "../../core/actions.js";
import type { PageSnapshot, PageText } from "../../core/elements.js";
import type { Executor, ExecutorCapabilities, ExecutorKind } from "../../core/executor.js";
import { BROWSER_APPS } from "../../core/mac.js";
import type { MacExecutor } from "./mac.js";

export interface FrontExecutorOptions {
  mac: MacExecutor;
  /** The user's Chrome through the bridge; used when a browser is in front and it is connected. */
  chrome?: Executor | null;
  /** The built-in browser, always ready. */
  fallback: Executor;
}

export class FrontExecutor implements Executor {
  readonly viewport = { width: 1280, height: 800 };
  private current: Executor;
  private readonly changeListeners = new Set<() => void>();
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    private readonly opts: FrontExecutorOptions,
    readonly id = "front",
  ) {
    this.current = opts.chrome?.ready ? opts.chrome : opts.fallback;
    for (const e of [opts.mac, opts.chrome, opts.fallback]) if (e) this.unsubscribe.push(e.onChange(() => this.changed()));
  }

  /** Reports the surface behind the last snapshot, so UIs label it chrome / mac / playwright. */
  get kind(): ExecutorKind {
    return this.current.kind;
  }

  /** The Mac can always picture a window, so "Your screen" has a frame even when the surface in
   *  charge (the system browser) cannot take one. */
  get capabilities(): ExecutorCapabilities {
    const c = this.current.capabilities;
    return c.screenshot || !this.opts.mac.ready ? c : { ...c, screenshot: true };
  }

  get ready(): boolean {
    return true; // the fallback always is
  }

  get url(): string {
    return this.current.url;
  }

  /** Which executor is answering right now. */
  get surface(): Executor {
    return this.current;
  }

  async start(): Promise<void> {
    await this.opts.mac.start();
  }

  /** Whatever the surface behind us knows about why it can't read. */
  get readHint(): string | null {
    return this.current.readHint ?? null;
  }

  /** Delegates to whichever surface answered last; absent when that surface cannot read. */
  read(max?: number): Promise<PageText> {
    const surface = this.current;
    if (!surface.read) throw new Error(`The ${surface.kind} surface cannot read page text`);
    return surface.read(max);
  }

  title(): Promise<string> {
    return this.current.title();
  }

  /** Look at what is in front, pick the surface for this turn, and snapshot it. */
  async snapshot(): Promise<PageSnapshot> {
    const next = await this.pick();
    if (next !== this.current) {
      this.current = next;
      this.changed();
    }
    return next === this.opts.mac ? this.opts.mac.snapshot(this.lastWindow) : next.snapshot();
  }

  private lastWindow: Awaited<ReturnType<MacExecutor["front"]>> = null;

  private async pick(): Promise<Executor> {
    const { mac, chrome, fallback } = this.opts;
    const browser = chrome?.ready ? chrome : fallback;
    if (!mac.ready) return browser;
    try {
      this.lastWindow = await mac.front();
    } catch {
      return browser;
    }
    const w = this.lastWindow;
    if (!w) return browser;
    if (BROWSER_APPS.has(w.app_name)) return browser;
    return mac;
  }

  /** Which surface the panel pictures: the app Jev is working in while she works (Slack behind
   *  Chrome), else what is in front RIGHT NOW — looked up on every frame, not only when the fast
   *  lane took a snapshot. Live 2026-09-28 "Your screen" stayed on the surface of the last fast-lane
   *  command while the user was in Chrome; it is his screen, so it follows him. */
  private async pictured(): Promise<Executor | null> {
    const { mac, chrome } = this.opts;
    if (!mac.ready) return this.current.capabilities.screenshot ? this.current : null;
    if (mac.working) return mac;
    const w = await this.frontNow();
    if (w && BROWSER_APPS.has(w.app_name) && chrome?.ready && chrome.capabilities.screenshot) return chrome;
    return mac;
  }

  /** The front window, looked up at most once a second (the frame loop ticks faster). */
  private frontCache: { at: number; win: Awaited<ReturnType<MacExecutor["front"]>> } | null = null;
  private async frontNow(): Promise<Awaited<ReturnType<MacExecutor["front"]>>> {
    const now = Date.now();
    if (this.frontCache && now - this.frontCache.at < 1000) return this.frontCache.win;
    const win = await this.opts.mac.front().catch(() => null);
    this.frontCache = { at: now, win };
    return win;
  }

  /** The surface behind the last frame: the user's clicks and keys land where he saw them. */
  private shown: Executor | null = null;

  async screenshot(): Promise<Uint8Array | null> {
    const s = await this.pictured();
    this.shown = s;
    return s ? s.screenshot() : null;
  }

  get frameProblem(): string | null {
    const s = this.shown;
    if (!s) return "Nothing to picture yet";
    return s.frameProblem ?? null;
  }

  async frameInfo(): Promise<{ url: string; title: string }> {
    const s = this.shown ?? this.current;
    return s.frameInfo ? s.frameInfo() : { url: s.url, title: await s.title() };
  }

  private shownForInput(): Executor {
    const s = this.shown;
    if (!s) throw new Error("Nothing on screen yet — wait for the picture.");
    return s;
  }

  inputClick(fx: number, fy: number): Promise<string> {
    const s = this.shownForInput();
    if (s.inputClick) return s.inputClick(fx, fy);
    if (!s.capabilities.clickAt) throw new Error(`Clicking isn't available on ${s.kind}`);
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return s.execute({ kind: "click_at", x: Math.round(clamp(fx) * s.viewport.width), y: Math.round(clamp(fy) * s.viewport.height), fx: clamp(fx), fy: clamp(fy) });
  }

  inputText(text: string): Promise<string> {
    const s = this.shownForInput();
    if (s.inputText) return s.inputText(text);
    return s.execute({ kind: "type", elementId: null, label: null, text, submit: false, focused: true });
  }

  inputKey(key: string): Promise<string> {
    const s = this.shownForInput();
    if (s.inputKey) return s.inputKey(key);
    return s.execute({ kind: "press", key });
  }

  execute(action: Action): Promise<string> {
    return this.current.execute(action);
  }

  async setViewport(): Promise<boolean> {
    return false;
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  private changed(): void {
    for (const cb of this.changeListeners) cb();
  }

  async close(): Promise<void> {
    for (const u of this.unsubscribe) u();
    // the delegates are registered surfaces of their own and are closed by their owner
  }
}
