/** The user's own Chrome, through the bridge extension. One executor lives for the whole
 *  process: the bridge attaches and detaches as the extension connects and reconnects, and
 *  while it is away every action fails fast with a clear message instead of hanging. */
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { Action } from "../../core/actions.js";
import { MAX_ELEMENTS, MAX_PAGE_TEXT, type PageSnapshot, type PageText } from "../../core/elements.js";
import type { Executor, ExecutorCapabilities } from "../../core/executor.js";
import { BRIDGE_PROTOCOL, type FromBridge, type RemoteOp, type RemoteResult, type TabInfo, type TabTarget, type ToBridge } from "../../core/remote.js";

export interface RemoteExecutorOptions {
  /** How long one request may take; navigation waits for the load, so allow for slow sites. */
  timeoutMs?: number;
  jpegQuality?: number;
  /** Keep-alive interval; the bridge answers each ping, and a missed answer drops the socket. */
  pingMs?: number;
  onReady?: (ready: boolean) => void;
}

interface Pending {
  resolve: (r: RemoteResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const NOT_CONNECTED = "Chrome isn't connected: install the Jev bridge extension and point it at this companion";
/** Actions only a protocol-4 bridge carries out as meant (see BRIDGE_PROTOCOL). */
export function needsPanelInput(action: Action): boolean {
  return (action.kind === "type" && !!action.focused) || (action.kind === "click_at" && action.fx !== undefined);
}

export const OUT_OF_DATE = "The Jev bridge extension is out of date — reload dist/extension in chrome://extensions";
/** An extension older than protocol 3 would ignore `tab` and act in the tab the user is looking at,
 *  which is exactly what the background window exists to avoid — so it is refused, by name. */
export const NO_BACKGROUND_TAB = "Jev's background Chrome window needs the updated bridge — reload dist/extension in chrome://extensions (one click), then ask again";

export class RemoteExecutor implements Executor {
  readonly kind = "chrome" as const;
  /** `read` flips on once a bridge has said hello with protocol >= 2; an older unpacked
   *  extension would reject the unknown op with a raw error, so we report the gap honestly. */
  readonly capabilities: ExecutorCapabilities = { screenshot: true, viewport: false, clickAt: true, read: false };
  private bridgeProtocol = 0;
  readonly viewport = { width: 1280, height: 800 };
  private socket: WebSocket | null = null;
  private tab: TabInfo | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly changeListeners = new Set<() => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private awaitingPong = false;
  private readonly timeoutMs: number;

  constructor(
    private readonly opts: RemoteExecutorOptions = {},
    readonly id = "chrome",
  ) {
    this.timeoutMs = opts.timeoutMs ?? 25_000;
  }

  /** The bridge is connected and has said hello. */
  get ready(): boolean {
    return this.socket !== null;
  }

  get url(): string {
    return this.tab?.url ?? "about:blank";
  }

  async start(): Promise<void> {}

  /** Keep one healthy owner. Duplicate installed extensions must not continually evict each
   * other and interrupt commands. A reconnect can take over after the old socket closes. */
  attach(ws: WebSocket): void {
    if (this.socket === ws) return;
    if (this.socket?.readyState === 1) {
      ws.on("error", () => {});
      ws.close(1013, "Another Jev bridge is already connected");
      return;
    }
    if (this.socket) this.detach(this.socket);
    this.socket = ws;
    this.awaitingPong = false;
    ws.on("message", (raw) => { if (this.socket === ws) this.onMessage(String(raw)); });
    ws.on("close", () => this.detach(ws));
    ws.on("error", () => this.detach(ws));
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.ping(), this.opts.pingMs ?? 20_000);
    this.opts.onReady?.(true);
    this.changed();
  }

  private detach(ws: WebSocket): void {
    if (this.socket !== ws) return;
    this.socket = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Chrome disconnected while working"));
      this.pending.delete(id);
    }
    this.opts.onReady?.(false);
    this.changed();
  }

  private ping(): void {
    if (!this.socket) return;
    if (this.awaitingPong) {
      this.socket.terminate();
      return;
    }
    this.awaitingPong = true;
    this.send({ type: "ping" });
  }

  private send(msg: ToBridge): void {
    this.socket?.send(JSON.stringify(msg));
  }

  private onMessage(raw: string): void {
    let msg: FromBridge;
    try {
      msg = JSON.parse(raw) as FromBridge;
    } catch {
      return;
    }
    switch (msg.type) {
      case "hello":
        if (msg.protocol !== BRIDGE_PROTOCOL) console.warn(`Chrome bridge speaks protocol ${msg.protocol}, companion ${BRIDGE_PROTOCOL}${msg.protocol < BRIDGE_PROTOCOL ? " — reload dist/extension in chrome://extensions to enable reading pages" : ""}`);
        this.bridgeProtocol = msg.protocol;
        this.capabilities.read = msg.protocol >= 2;
        this.tab = msg.tab;
        this.changed();
        break;
      case "pong":
        this.awaitingPong = false;
        break;
      case "tab":
        this.tab = msg.tab;
        this.changed();
        break;
      case "exec_res": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
        break;
      }
    }
  }

  /** The bridge's protocol, from its hello (0 before one). */
  get protocol(): number {
    return this.bridgeProtocol;
  }

  /** The same bridge, working in Jev's own background window of the user's Chrome. */
  jevTab(): Executor {
    return new JevTab(this);
  }

  /** @internal — for JevTab: one request, aimed at a tab. */
  requestTo<K extends RemoteOp["op"]>(req: Extract<RemoteOp, { op: K }>, tab: TabTarget): Promise<Extract<RemoteResult, { op: K }>> {
    if (tab === "jev" && this.socket && this.bridgeProtocol < 3) return Promise.reject(new Error(NO_BACKGROUND_TAB));
    return this.request({ ...req, tab } as Extract<RemoteOp, { op: K }>);
  }

  private request<K extends RemoteOp["op"]>(req: Extract<RemoteOp, { op: K }>): Promise<Extract<RemoteResult, { op: K }>> {
    if (!this.socket) return Promise.reject(new Error(NOT_CONNECTED));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome didn't answer within ${Math.round(this.timeoutMs / 1000)} s`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (r) => resolve(r as Extract<RemoteResult, { op: K }>), reject, timer });
      this.send({ type: "exec_req", id, req });
    });
  }

  async title(): Promise<string> {
    return this.tab?.title ?? "";
  }

  async snapshot(): Promise<PageSnapshot> {
    const { snapshot } = await this.request({ op: "snapshot", max: MAX_ELEMENTS });
    this.tab = { url: snapshot.url, title: snapshot.title };
    return { url: snapshot.url, title: snapshot.title, elements: snapshot.elements.map((e, i) => ({ id: `e${i}`, ...e })) };
  }

  /** A connected-but-old bridge is the one case worth explaining: the fix is one click in
   *  chrome://extensions, and without this the caller only ever sees "cannot read page text". */
  get readHint(): string | null {
    return this.socket && this.bridgeProtocol > 0 && this.bridgeProtocol < 2 ? OUT_OF_DATE : null;
  }

  async read(max = MAX_PAGE_TEXT): Promise<PageText> {
    if (this.bridgeProtocol < 2) throw new Error(OUT_OF_DATE);
    const { page } = await this.request({ op: "read", max });
    return { url: this.tab?.url ?? "", title: this.tab?.title ?? "", ...page };
  }

  /** Why the last picture of his tab is missing, for the panel. */
  frameProblem: string | null = null;

  async screenshot(): Promise<Uint8Array | null> {
    if (!this.socket) {
      this.frameProblem = "Chrome's Jev extension isn't connected";
      return null;
    }
    try {
      const { jpegBase64 } = await this.request({ op: "screenshot", quality: this.opts.jpegQuality ?? 60 });
      this.frameProblem = jpegBase64 ? null : "Chrome didn't give a picture of the tab";
      return jpegBase64 ? Buffer.from(jpegBase64, "base64") : null;
    } catch (err) {
      this.frameProblem = `Couldn't picture the Chrome tab (${err instanceof Error ? err.message : String(err)})`;
      return null;
    }
  }

  async execute(action: Action): Promise<string> {
    // the user's own typing through the panel needs a bridge that types at the caret: an older one
    // ignores `focused` and would overwrite the page's first field with every keystroke batch.
    if (needsPanelInput(action) && this.bridgeProtocol < 4) throw new Error(OUT_OF_DATE);
    const { status } = await this.request({ op: "execute", action });
    return status;
  }

  async setViewport(): Promise<boolean> {
    return false; // the user's window is theirs
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  private changed(): void {
    for (const cb of this.changeListeners) cb();
  }

  async close(): Promise<void> {
    this.socket?.close(1001, "companion closing");
    this.socket = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
  }
}

/** the user's Chrome, but in Jev's own window: a minimized window of the same profile, so every login
 *  he has is there and nothing he sees changes — his tabs, his focus and his mouse stay his. The
 *  brain's `chrome` tool works here; the fast lane ("click the pricing link") stays on his tab. */
export class JevTab implements Executor {
  readonly kind = "chrome" as const;
  readonly id = "chrome-jev";
  readonly viewport = { width: 1280, height: 800 };
  private tabInfo: TabInfo | null = null;

  constructor(private readonly bridge: RemoteExecutor) {}

  get capabilities(): ExecutorCapabilities {
    return { screenshot: false, viewport: false, clickAt: false, read: this.bridge.protocol >= 3 };
  }

  get ready(): boolean {
    return this.bridge.ready;
  }

  get url(): string {
    return this.tabInfo?.url ?? "about:blank";
  }

  get readHint(): string | null {
    return this.bridge.ready && this.bridge.protocol < 3 ? NO_BACKGROUND_TAB : null;
  }

  async start(): Promise<void> {}

  async title(): Promise<string> {
    return this.tabInfo?.title ?? "";
  }

  async snapshot(): Promise<PageSnapshot> {
    const { snapshot } = await this.bridge.requestTo({ op: "snapshot", max: MAX_ELEMENTS }, "jev");
    this.tabInfo = { url: snapshot.url, title: snapshot.title };
    return { url: snapshot.url, title: snapshot.title, elements: snapshot.elements.map((e, i) => ({ id: `e${i}`, ...e })) };
  }

  async read(max = MAX_PAGE_TEXT): Promise<PageText> {
    const { page } = await this.bridge.requestTo({ op: "read", max }, "jev");
    const { tab } = await this.bridge.requestTo({ op: "tab" }, "jev");
    if (tab) this.tabInfo = tab;
    return { url: this.tabInfo?.url ?? "", title: this.tabInfo?.title ?? "", ...page };
  }

  async screenshot(): Promise<Uint8Array | null> {
    return null; // a minimized window has nothing visible to capture
  }

  async execute(action: Action): Promise<string> {
    if (needsPanelInput(action) && this.bridge.protocol < 4) throw new Error(OUT_OF_DATE);
    const { status } = await this.bridge.requestTo({ op: "execute", action }, "jev");
    // where Jev's window is now: the brain learns real hosts from where pages actually land
    try {
      const { tab } = await this.bridge.requestTo({ op: "tab" }, "jev");
      if (tab) this.tabInfo = tab;
    } catch {
      /* the action happened; its address is a nicety */
    }
    return status;
  }

  async setViewport(): Promise<boolean> {
    return false;
  }

  onChange(cb: () => void): () => void {
    return this.bridge.onChange(cb);
  }

  async close(): Promise<void> {}
}
