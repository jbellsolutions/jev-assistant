/** Owns every Session (one per executor) and fans its messages out to the WebSocket UIs
 *  attached to it, streaming JPEG frames when the executor can produce them. */
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import type { Brain } from "../core/brain.js";
import type { Decider } from "../core/decide.js";
import type { Executor } from "../core/executor.js";
import type { BridgeInfo, ListenSettings, ServerMessage, TalkTo, VoiceInfo } from "../core/protocol.js";
import type { SessionStatus } from "../core/results.js";
import { type Computer, Session } from "../core/session.js";
import type { Speaker } from "../core/speak.js";
import { TimerStore } from "../core/timers.js";

/** An unchanged frame is still sent this often, so the panel knows the picture is live. */
export const FRAME_HEARTBEAT_MS = 5_000;

/** Pushes a frame when the surface changed (or every interval as a safety net), skipping
 *  frames identical to the last one so an idle page costs nothing. */
export class FrameStreamer {
  private lastHash = "";
  private inFlight = false;
  private dirty = true;
  private timer: NodeJS.Timeout | null = null;
  clients = 0;

  constructor(
    private readonly executor: Executor,
    private readonly send: (msg: ServerMessage) => void,
    private readonly intervalMs: number,
  ) {}

  markDirty(): void {
    this.dirty = true;
  }

  /** Runs whether or not the surface can take a picture right now: that can change (the front
   *  executor starts on a browser that can't, then Jev opens Slack), and a loop that never started
   *  left "Your screen" on "waiting for the screen" for good. `push` checks on every tick. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.push(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** When the last frame went out, and the last problem told to the panel (said once, not per tick). */
  private sentAt = 0;
  private problem: string | null = null;

  async push(force = false): Promise<void> {
    if (this.inFlight || this.clients === 0 || !this.executor.capabilities.screenshot) return;
    this.inFlight = true;
    try {
      const buf = await this.executor.screenshot();
      const now = Date.now();
      if (!buf) {
        // A missing picture is said, not swallowed: live 2026-09-28 the panel kept an old frame with
        // nothing to show it was old. The panel labels itself "not live" from this.
        const reason = this.executor.frameProblem ?? "No picture";
        if (reason !== this.problem || force) this.send({ type: "frame_status", ok: false, reason, at: now });
        this.problem = reason;
        return;
      }
      this.problem = null;
      const hash = createHash("md5").update(buf).digest("hex");
      // Even an unchanged picture goes out now and then, so the panel can tell "still" from "stuck".
      const due = now - this.sentAt >= FRAME_HEARTBEAT_MS;
      if (!force && !this.dirty && !due && hash === this.lastHash) return;
      this.lastHash = hash;
      this.dirty = false;
      this.sentAt = now;
      const info = this.executor.frameInfo ? await this.executor.frameInfo() : { url: this.executor.url, title: await this.executor.title() };
      this.send({ type: "screenshot", jpegBase64: Buffer.from(buf).toString("base64"), url: info.url, title: info.title, at: now });
    } catch (err) {
      this.problem = err instanceof Error ? err.message : String(err);
      this.send({ type: "frame_status", ok: false, reason: this.problem, at: Date.now() });
    } finally {
      this.inFlight = false;
    }
  }
}

interface Entry {
  session: Session;
  clients: Set<WebSocket>;
  streamer: FrameStreamer;
  unsubscribe: () => void;
}

export interface HubOptions {
  decider: Decider;
  screenshotIntervalMs: number;
  /** Session id programmatic callers and new UIs get when they don't name one. */
  defaultSession?: string;
  brain?: Brain | null;
  computer?: Computer | null;
  speaker?: Speaker | null;
  /** One line describing the voice, for the panel's indicator. */
  voice?: () => VoiceInfo;
  /** Read fresh on every hello, so a panel that reconnects sees the current choice rather than
   *  whatever was true when the process started. */
  listen?: () => ListenSettings;
  /** Where the panel can embed Jev's own browser, live and clickable. */
  browserView?: () => string | null;
  /** The co-founder's computer for the panel's third tab, or why there isn't one. */
  cofounder?: () => { computer: string } | { off: string };
  bridge?: () => BridgeInfo;
  /** "mute yourself" said to any session flips the one voice. */
  onMute?: (muted: boolean) => void;
  /** Who the user is talking to; one switch for every session. */
  talkingTo?: () => TalkTo;
  onTalkTo?: (to: TalkTo) => void;
  toCofounder?: (text: string) => string;
}

export class Hub {
  /** Cleared on close(), so a pending alarm cannot keep the process alive or fire after shutdown. */
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly entries = new Map<string, Entry>();
  private readonly owner = new Map<WebSocket, string>();
  /** Panels that said nobody is looking at their picture right now. */
  private readonly resting = new Set<WebSocket>();
  private pausedFlag = false;
  private readonly pauseListeners = new Set<(paused: boolean) => void>();

  constructor(private readonly opts: HubOptions) {}

  /** Off means off: while paused nothing is heard, said or done, whoever asks. */
  get paused(): boolean {
    return this.pausedFlag;
  }

  setPaused(paused: boolean): void {
    if (this.pausedFlag === paused) return;
    this.pausedFlag = paused;
    if (paused) for (const e of this.entries.values()) e.session.cancel(true);
    const msg: ServerMessage = { type: "paused", paused };
    const data = JSON.stringify(msg);
    for (const ws of this.owner.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(data);
    for (const fn of this.pauseListeners) fn(paused);
  }

  onPause(fn: (paused: boolean) => void): () => void {
    this.pauseListeners.add(fn);
    return () => this.pauseListeners.delete(fn);
  }

  register(executor: Executor): Session {
    const id = executor.id;
    if (this.entries.has(id)) throw new Error(`Session ${id} already registered`);
    const clients = new Set<WebSocket>();
    const streamer = new FrameStreamer(executor, (msg) => this.broadcast(id, msg), this.opts.screenshotIntervalMs);
    const session = new Session(id, {
      executor,
      decider: this.opts.decider,
      brain: this.opts.brain,
      computer: this.opts.computer,
      speaker: this.opts.speaker,
      // One store per session, and the host owns the clock: a timer fires OUTSIDE the command
      // queue, so a long browser task cannot delay an alarm.
      timers: new TimerStore(),
      scheduleTimer: (ms, fire) => {
        const handle = setTimeout(fire, ms);
        handle.unref?.();
        this.pendingTimers.add(handle);
      },
      afterAction: () => streamer.push(true),
      onSleep: () => this.setPaused(true),
      onMute: this.opts.onMute,
      talkingTo: this.opts.talkingTo,
      onTalkTo: this.opts.onTalkTo,
      toCofounder: this.opts.toCofounder,
    });
    const unsubSession = session.subscribe((msg) => this.broadcast(id, msg));
    // Every change pushes a frame now, not on the next tick: Jev acting in Slack shows as she acts.
    const unsubChange = executor.onChange(() => {
      streamer.markDirty();
      void streamer.push();
    });
    this.entries.set(id, {
      session,
      clients,
      streamer,
      unsubscribe: () => {
        unsubSession();
        unsubChange();
      },
    });
    return session;
  }

  unregister(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.streamer.stop();
    e.unsubscribe();
    for (const ws of e.clients) this.owner.delete(ws);
    this.entries.delete(id);
  }

  get(id: string): Session | undefined {
    return this.entries.get(id)?.session;
  }

  /** Explicit default, else the user's Chrome when the bridge is connected, else Playwright, else anything ready. */
  get defaultId(): string | null {
    const d = this.opts.defaultSession;
    if (d && this.entries.has(d)) return d;
    const ready = (id: string) => this.entries.get(id)?.session.executor.ready !== false;
    // "front" stands for whatever the user is looking at (their Chrome tab or the Mac app);
    // then the Chrome bridge on its own, then the built-in browser
    for (const id of ["front", "chrome", "system"]) if (this.entries.has(id) && ready(id)) return id;
    return [...this.entries.keys()].find(ready) ?? this.entries.keys().next().value ?? null;
  }

  /** The preferred surface changed (the Chrome bridge came or went): every UI follows it and
   *  gets a fresh hello for the new session. */
  followDefault(): void {
    const target = this.defaultId;
    if (!target) return;
    for (const [ws, id] of [...this.owner]) if (id !== target) this.attach(ws, target);
  }

  sessionFor(ws: WebSocket): Session | undefined {
    const id = this.owner.get(ws);
    return id ? this.get(id) : undefined;
  }

  /** Every registered session, for callers that need to choose among the surfaces themselves. */
  sessions(): Session[] {
    return [...this.entries.values()].map((e) => e.session);
  }

  async statuses(): Promise<SessionStatus[]> {
    return Promise.all([...this.entries.values()].map((e) => e.session.status()));
  }

  /** Attach a UI socket to a session (moving it if it was attached elsewhere) and send hello. */
  attach(ws: WebSocket, sessionId: string): boolean {
    const e = this.entries.get(sessionId);
    if (!e) return false;
    this.detach(ws);
    e.clients.add(ws);
    this.owner.set(ws, sessionId);
    e.streamer.clients = this.watching(e);
    const executor = e.session.executor;
    const hello: ServerMessage = {
      type: "hello",
      jev: { enabled: this.opts.decider.enabled, model: this.opts.decider.model },
      viewport: executor.viewport,
      paused: this.pausedFlag,
      ...(this.opts.listen ? { listen: this.opts.listen() } : {}),
      ...(this.opts.voice ? { voice: this.opts.voice() } : {}),
      ...(this.opts.browserView ? { browserView: this.opts.browserView() } : {}),
      ...(this.opts.cofounder ? { cofounder: this.opts.cofounder() } : {}),
      ...(this.opts.bridge ? { bridge: this.opts.bridge() } : {}),
      ...(this.opts.talkingTo ? { talkingTo: this.opts.talkingTo() } : {}),
    };
    ws.send(JSON.stringify(hello));
    e.streamer.start();
    e.streamer.markDirty();
    void e.streamer.push(true);
    return true;
  }

  detach(ws: WebSocket): void {
    const id = this.owner.get(ws);
    if (!id) return;
    const e = this.entries.get(id);
    this.owner.delete(ws);
    if (!e) return;
    e.clients.delete(ws);
    this.resting.delete(ws);
    e.streamer.clients = this.watching(e);
    if (e.clients.size === 0) e.streamer.stop();
  }

  /** A panel saying whether anyone is looking at its picture. Capturing a window costs a driver
   *  call and a JPEG conversion every tick, so a hidden panel (or one on another tab) stops it. */
  setFrames(ws: WebSocket, on: boolean): void {
    const e = this.entries.get(this.owner.get(ws) ?? "");
    if (!e) return;
    if (on) this.resting.delete(ws);
    else this.resting.add(ws);
    e.streamer.clients = this.watching(e);
    if (!on) return;
    e.streamer.markDirty();
    void e.streamer.push(true);
  }

  private watching(e: Entry): number {
    let n = 0;
    for (const ws of e.clients) if (!this.resting.has(ws)) n++;
    return n;
  }

  requestFrame(ws: WebSocket): void {
    const e = this.entries.get(this.owner.get(ws) ?? "");
    if (!e) return;
    e.streamer.markDirty();
    void e.streamer.push(true);
  }

  /** To every UI, whichever session it is attached to. A task is a job the user started, so its
   *  progress belongs in their panel even when it runs on a surface they are not watching —
   *  which is the normal case, since the panel follows the default session. */
  broadcastAll(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.owner.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  broadcast(sessionId: string, msg: ServerMessage): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    const data = JSON.stringify(msg);
    for (const ws of e.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  async close(): Promise<void> {
    for (const t of this.pendingTimers) clearTimeout(t);
    this.pendingTimers.clear();
    for (const id of [...this.entries.keys()]) {
      const e = this.entries.get(id)!;
      this.unregister(id);
      await e.session.executor.close();
    }
  }
}
