/** When the user's Chrome isn't connected. The fast lane still opens a URL or a web search — in his
 *  default browser, through macOS `open`, where he can SEE it — and says plainly that anything more
 *  (clicking, typing, reading) needs the Jev bridge extension.
 *
 *  This replaces the hidden Playwright browser. That one "did" things nobody could see: "open
 *  wikipedia" reported success into a headless window, which reads exactly like Jev lying. Jev's
 *  own browsers now live in browser-box, which the brain uses by name. */
import { execFile } from "node:child_process";
import type { Action } from "../../core/actions.js";
import type { PageSnapshot } from "../../core/elements.js";
import type { Executor, ExecutorCapabilities } from "../../core/executor.js";

export const NOT_CONNECTED = "Your Chrome isn't connected to Jev (the Jev bridge extension is off), so I can open pages but not click or type in them.";

export type Opener = (url: string) => Promise<void>;

const macOpen: Opener = (url) =>
  new Promise((resolve, reject) => execFile("/usr/bin/open", [url], { timeout: 10_000 }, (err) => (err ? reject(err) : resolve())));

export class SystemBrowser implements Executor {
  readonly kind = "chrome" as const;
  readonly capabilities: ExecutorCapabilities = { screenshot: false, viewport: false, clickAt: false, read: false };
  readonly viewport = { width: 1280, height: 800 };
  readonly ready = true;
  readonly readHint = NOT_CONNECTED;
  url = "about:blank";

  constructor(
    private readonly open: Opener = macOpen,
    readonly id = "system",
  ) {}

  async start(): Promise<void> {}
  async title(): Promise<string> {
    return "Your browser";
  }
  async snapshot(): Promise<PageSnapshot> {
    return { url: this.url, title: "Your browser", elements: [] };
  }
  async screenshot(): Promise<Uint8Array | null> {
    return null;
  }
  async execute(action: Action): Promise<string> {
    if (action.kind === "navigate" || action.kind === "search") {
      await this.open(action.url);
      this.url = action.url;
      return action.kind === "search" ? `Searched for "${action.query}" in your browser` : `Opened ${action.url} in your browser`;
    }
    throw new Error(NOT_CONNECTED);
  }
  async setViewport(): Promise<boolean> {
    return false;
  }
  onChange(): () => void {
    return () => {};
  }
  async close(): Promise<void> {}
}
