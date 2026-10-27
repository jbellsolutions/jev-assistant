/** The companion: HTTP + WebSocket server around a Hub of sessions. Built as a factory so
 *  the CLI (index.ts), the desktop app and the tests can all run one in-process. */
import { existsSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import type { Brain } from "../core/brain.js";
import type { Decider } from "../core/decide.js";
import type { Executor } from "../core/executor.js";
import type { BridgeInfo, ClientMessage, ServerMessage, TalkTo, VoiceInfo } from "../core/protocol.js";
import { BRIDGE_PROTOCOL } from "../core/remote.js";
import type { Computer } from "../core/session.js";
import { AttachmentStore, attachmentRoute, MAX_ATTACHMENTS_PER_MESSAGE } from "./attachments.js";
import { type Auth, allowedOrigins, createAuth, socketAllowed, tokenPresented } from "./auth.js";
import type { RemoteExecutor } from "./executors/remote.js";
import { demoPage } from "./demo.js";
import { createApi } from "./http.js";
import { Hub } from "./hub.js";
import { attachSttRelay } from "./stt/relay.js";
import type { SttProvider } from "./stt/types.js";
import type { Speaker } from "../core/speak.js";
import type { MuteSwitch, SpeechGate } from "./speak/gate.js";
import { type Cofounder, DONE_STATES, newRequestId } from "./cofounder.js";
import { describeSpeaker } from "./speak/select.js";
import { OutputDevice, type ReadDevice } from "./speak/device.js";
import { line } from "../core/lines.js";
import { spokenPart } from "../core/speak.js";
import { readState, writeState } from "./state.js";
import type { AssistantRuntime } from "./assistant/runtime.js";
import { PhoneAccess } from "./phone.js";

export interface CompanionOptions {
  phone?: { home: string; port?: number };
  assistant?: AssistantRuntime;
  decider: Decider;
  token?: string;
  /** Directory holding the built web client; served at / when present. */
  clientDir?: string;
  screenshotIntervalMs?: number;
  defaultSession?: string;
  /** Extra origins allowed to open UI sockets (e.g. "chrome-extension://*"). */
  extraOrigins?: string[];
  /** Streaming speech-to-text for /ws/stt; without one, the socket refuses the connection. */
  stt?: SttProvider | null;
  /** Wake mode's always-on, on-device listener. Separate from `stt` because the two jobs want
   *  different engines: free and local for the room, accurate for the command. */
  sttListener?: SttProvider | null;
  /** Jev's voice; without one she works exactly as before, silently. */
  speaker?: Speaker | null;
  /** The same line `createVoice` prints at startup, so the panel and stdout cannot disagree about
   *  which voice is speaking — or why none is. Derived from the speaker when not given. */
  voiceDescription?: string;
  /** Reads the Mac's output device for the voice pill (native/jev-audio-out). Without it the pill
   *  names no device. */
  outputDevice?: ReadDevice;
  /** Shared "is audio playing" signal. The relay consults it so the microphone never hears Jev's
   *  own reply — checked in-process because a renderer round trip is itself the window she would
   *  be heard in (server/speak/gate.ts). */
  gate?: SpeechGate | null;
  /** the user's mute, shared with the speaker that enforces it. Persisted and shown in the panel. */
  mute?: MuteSwitch | null;
  /** The brain behind anything that is not an instant command; without one those stay local. */
  brain?: Brain | null;
  /** The Mac lane (open apps); without one "open slack" goes to the brain or is refused. */
  computer?: Computer | null;
  /** The user's Chrome, reached through the bridge extension on /ws/bridge. */
  bridge?: RemoteExecutor | null;
  /** Jev's own browser, live in the panel (browser-box's player); null hides that tab. */
  browserView?: string | null;
  /** The co-founder on Orgo, for its live desktop tab; null says it isn't configured. */
  cofounder?: Cofounder | null;
  /** Where the panel's 📎 files go; ~/.jev/attachments when not given. */
  attachments?: AttachmentStore;
}

export interface Companion {
  hub: Hub;
  auth: Auth;
  /** Listen on every loopback address (localhost resolves to ::1 first on many Macs). */
  listen(port: number): Promise<number>;
  register(executor: Executor): void;
  /** Re-reads the output device now (it is otherwise polled); open panels hear about a change. */
  refreshOutputDevice(): Promise<void>;
  /** Something that arrived on its own (the co-founder's late reply): a log entry in every panel,
   *  and said aloud unless Jev is muted or paused. */
  announce(from: string, text: string, level?: "ok" | "warn", spoken?: string): void;
  close(): Promise<void>;
}

export function createCompanion(opts: CompanionOptions): Companion {
  const auth = createAuth(opts.token);
  const bridgeInfo = (): BridgeInfo => (opts.bridge?.ready && opts.bridge.protocol > 0 ? { protocol: opts.bridge.protocol, current: BRIDGE_PROTOCOL } : null);
  // Declared before the hub, which asks for `voice()` on every hello.
  let device: OutputDevice | null = null;
  const voice = (): VoiceInfo => ({
    on: !!opts.speaker,
    detail: (opts.voiceDescription ?? describeSpeaker(opts.speaker ?? null)).replace(/^voice out: /, ""),
    device: device?.current ?? null,
    muted: opts.mute?.muted ?? false,
  });
  // Said aloud unless muted or paused; the panel always gets the entry.
  const announce = (from: string, text: string, level: "ok" | "warn" = "ok", spoken?: string) => {
    hub.broadcastAll({ type: "notice", from, text, level });
    const speaker = opts.speaker;
    // The speaker enforces mute itself; paused means nothing is said at all.
    if (speaker && !hub.paused) void speaker.speak(spokenPart(spoken ?? text, speaker.maxChars)).catch(() => {}); // a long late reply is read in the panel, not aloud
  };

  // Talking to the co-founder directly (v11.4). Without a co-founder there is nothing to switch to.
  let talkingTo: TalkTo = opts.cofounder && readState().talkingTo === "cofounder" ? "cofounder" : "jev";
  const setTalkingTo = (to: TalkTo) => {
    const next: TalkTo = to === "cofounder" && opts.cofounder ? "cofounder" : "jev";
    talkingTo = next;
    writeState({ talkingTo: next });
    hub.broadcastAll({ type: "talking_to", to: next });
  };
  /** the user's words to the co-founder, as he wrote them — no approval, he is the one writing. The
   *  Studio resumes the same session every time, so its own context carries the conversation. The
   *  reply lands as a panel entry and is spoken; a slow one is checked every 10s rather than the
   *  hand-off watcher's 45s, because this is a conversation. */
  const toCofounder = (text: string): string => {
    const c = opts.cofounder;
    if (!c) return "The co-founder isn't connected (ORGO_API_KEY).";
    const id = newRequestId();
    c.send(text, id, { rounds: 2, waitSeconds: 25 }).then(
      (d) => {
        if (d.state === "complete") announce("↩ The co-founder", d.result || "(an empty reply)", "ok", d.result);
        else if (DONE_STATES.has(d.state)) announce("↩ The co-founder", `That ended ${d.state}${d.result ? `: ${d.result}` : ""}`, "warn");
        else c.watch(id, text, { everyMs: 10_000 });
      },
      (err: unknown) => announce("↩ The co-founder", `Couldn't reach the co-founder: ${err instanceof Error ? err.message : String(err)}`, "warn"),
    );
    return "Sent to the co-founder.";
  };

  const hub = new Hub({
    decider: opts.decider,
    screenshotIntervalMs: opts.screenshotIntervalMs ?? 700,
    defaultSession: opts.defaultSession,
    brain: opts.brain,
    computer: opts.computer,
    speaker: opts.speaker,
    // The panel asks, because stdout is not an answer for an app launched from the Dock. `on` is
    // the speaker the hub actually holds — not a second reading of the environment, which can
    // disagree with it — and the detail is the startup line verbatim, so both say the same thing.
    voice,
    // Wake mode is only offered when the free on-device recogniser is actually there; without it
    // the relay refuses the mode, and a switch that cannot work is worse than no switch.
    browserView: () => opts.browserView ?? null,
    cofounder: () => (opts.cofounder ? { computer: opts.cofounder.computerId } : { off: "Needs ORGO_API_KEY in Jev's .env" }),
    bridge: () => bridgeInfo(),
    listen: () => ({ mode: opts.sttListener ? (readState().listenMode ?? "push") : "push", wakeAvailable: !!opts.sttListener }),
    onMute: opts.mute ? (muted) => opts.mute!.set(muted) : undefined,
    talkingTo: () => talkingTo,
    onTalkTo: setTalkingTo,
    toCofounder: opts.cofounder ? toCofounder : undefined,
  });

  // However it was flipped — the pill, or "mute yourself" — it is remembered and every panel sees it.
  // Every panel hears when the extension connects, drops or turns out to be an old build.
  let lastBridge = "";
  const unsubBridge = opts.bridge?.onChange(() => {
    const bridge = bridgeInfo();
    const key = JSON.stringify(bridge);
    if (key === lastBridge) return;
    lastBridge = key;
    hub.broadcastAll({ type: "bridge", bridge });
  });
  const unsubMute = opts.mute?.onChange((muted) => {
    writeState({ muted });
    hub.broadcastAll({ type: "voice", voice: voice() });
  });

  // One source of truth for "Jev is talking", covering every line from every lane — including the
  // relay's "Yes?", which belongs to no command.
  opts.gate?.onChange((speaking) => hub.broadcastAll({ type: "speaking", active: speaking }));

  // The device is re-read on a timer, so unplugging the headset shows in the panel without a reload.
  if (opts.outputDevice) device = new OutputDevice(opts.outputDevice, () => hub.broadcastAll({ type: "voice", voice: voice() })).start();

  const app = express();
  if (opts.clientDir) {
    const clientDir = opts.clientDir;
    app.use(express.static(clientDir));
    app.get("/", (_req, res, next) => {
      if (existsSync(path.join(clientDir, "index.html"))) return next();
      res.status(503).type("text").send("Client not built. Run `npm run build` (or `npm run dev` for the Vite dev server on :5173).");
    });
  }
  app.get("/demo", (req, res) => {
    res.type("html").send(demoPage(String(req.query.page ?? "home")));
  });
  app.use("/api", createApi({ hub, auth, decider: opts.decider }));

  const wss = new WebSocketServer({ noServer: true });
  const sttWss = new WebSocketServer({ noServer: true });
  const bridgeWss = new WebSocketServer({ noServer: true });
  let origins = allowedOrigins(0, opts.extraOrigins);
  const authorize: express.RequestHandler = (req, res, next) => {
    // Same-origin renderer fetches require a non-simple header; arbitrary sites get no CORS grant.
    const origin = req.header("origin");
    const ownOrigin = `${req.protocol}://${req.get("host")}`;
    const ui = req.header("x-jev-ui") === "1" && origins.has(ownOrigin) && (origin ? origins.has(origin) : req.header("sec-fetch-site") === "same-origin");
    if (ui || tokenPresented({ headers: { authorization: req.header("authorization") } }, auth)) return next();
    res.status(401).json({ error: "Open the Jev app or authenticate with its companion token" });
  };
  opts.assistant?.mount(app, authorize);
  const phone = opts.phone && opts.assistant && opts.clientDir ? new PhoneAccess({ home: opts.phone.home, assistant: opts.assistant, clientDir: opts.clientDir }) : undefined;
  phone?.mountDesktop(app, authorize);
  const unsubAssistantPause = opts.assistant ? hub.onPause((p) => opts.assistant!.setPaused(p)) : undefined;
  // the panel's files: allowed exactly like the panel's own socket (its origin, or the token)
  const attachments = opts.attachments ?? new AttachmentStore();
  app.use(attachmentRoute(attachments, (req) => socketAllowed({ url: req.url, headers: { ...(req.header("origin") !== undefined ? { origin: req.header("origin")! } : {}), ...(req.header("authorization") ? { authorization: req.header("authorization")! } : {}) } }, auth, origins)));

  // the bridge drives the user's browser: it always presents the token (the extension's
  // origin alone is not enough), and UIs follow Chrome while it is connected
  bridgeWss.on("connection", (ws: WebSocket) => {
    const bridge = opts.bridge;
    if (!bridge) return ws.close(1013, "no Chrome bridge configured");
    bridge.attach(ws);
  });

  sttWss.on("connection", (ws: WebSocket) => {
    if (!opts.stt) return ws.close(1013, "no speech-to-text provider configured");
    attachSttRelay(ws, {
      provider: opts.stt,
      listener: opts.sttListener,
      // Two different silences, and folding them together was a bug:
      //   `paused` — hear NOTHING, not even into the buffer. The hub's rule is that while paused
      //     nothing is heard, said or done, so audio from a paused minute must not be replayed to a
      //     metered engine on the next wake.
      //   `deaf`   — Jev is talking. Her voice reaches no engine, but the buffer keeps filling, or a
      //     command spoken over her loses its first half.
      paused: () => hub.paused,
      ...(opts.gate ? { deaf: () => opts.gate!.deaf() } : {}),
      ...(opts.speaker
        ? {
            onWake: () => {
              if (hub.paused) return;
              const said = line("wake");
              // .catch is not optional here. `void` on a rejecting promise is an unhandled rejection
              // and Node exits on those — so one Fish hiccup on the wake line would look like "Jev
              // randomly quits". Unreachable until a TTS key exists, which is exactly why it survived.
              void opts.speaker!.speak(said).catch(() => {});
              return said; // so the relay can take her own answer back out of the command
            },
          }
        : {}),
    });
  });

  const historyBusy = new WeakSet<WebSocket>();
  wss.on("connection", (ws: WebSocket) => {
    const defaultId = hub.defaultId;
    if (!defaultId || !hub.attach(ws, defaultId)) {
      ws.close(1013, "no session available");
      return;
    }
    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      const session = hub.sessionFor(ws);
      if (!session) return;
      switch (msg.type) {
        case "command":
          if (typeof msg.text !== "string") break;
          if (hub.paused) {
            ws.send(JSON.stringify({ type: "status", text: "Jev is paused — resume from the tray, ⌥Space, or the panel", level: "warn" } satisfies ServerMessage));
            break;
          }
          // The panel and the microphone are the two human surfaces, and the only ones that speak.
          // /api/* callers pass nothing and stay silent — see the note on Session.command.
          {
            // only files this companion stored; a made-up id never reaches the brain
            const files = (Array.isArray(msg.attachments) ? msg.attachments : []).slice(0, MAX_ATTACHMENTS_PER_MESSAGE).flatMap((a) => {
              const meta = typeof a?.id === "string" ? attachments.get(a.id) : null;
              return meta ? [{ id: meta.id, name: meta.name }] : [];
            });
            void session.command(msg.text, { speak: true, ...(files.length ? { attachments: files } : {}) });
          }
          break;
        case "pause":
          hub.setPaused(!!msg.paused);
          break;
        // Clicking an answer is a human at the panel, exactly like typing one — so the outcome is
        // read out too. Without this the question is spoken and its answer lands in silence.
        case "confirm_reply":
          void session.reply(!!msg.ok, { speak: true });
          break;
        case "pick":
          void session.pick(String(msg.elementId), { speak: true });
          break;
        case "approval_reply":
          if (["once", "session", "always", "deny"].includes(String(msg.choice))) void session.approve(msg.choice, { speak: true });
          break;
        case "interrupt":
          session.interrupt();
          break;
        case "hush":
          session.hush();
          break;
        case "click_at":
          void session.inputClick(Number(msg.fx), Number(msg.fy));
          break;
        case "type_at":
          void session.inputText(String(msg.text ?? ""));
          break;
        case "key_at":
          void session.inputKey(String(msg.key ?? ""));
          break;
        case "viewport":
          void session.setViewport(Number(msg.width), Number(msg.height));
          break;
        case "screenshot_request":
          hub.requestFrame(ws);
          break;
        case "frames":
          if (typeof msg.on === "boolean") hub.setFrames(ws, msg.on);
          break;
        case "cofounder_view": {
          // To this socket only, and never logged: the password changes each restart of that computer.
          const reply = (m: ServerMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
          if (!opts.cofounder) reply({ type: "cofounder_view", error: "The co-founder isn't connected: Jev needs ORGO_API_KEY in its .env." });
          else
            opts.cofounder.view().then(
              (v) => reply({ type: "cofounder_view", ...v }),
              (err: unknown) => reply({ type: "cofounder_view", error: err instanceof Error ? err.message : String(err) }),
            );
          break;
        }
        case "cofounder_frame": {
          const reply = (m: ServerMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
          if (!opts.cofounder) reply({ type: "cofounder_frame", jpegBase64: null, error: "not connected" });
          else
            opts.cofounder.screenshot().then(
              (f) => reply({ type: "cofounder_frame", jpegBase64: f?.jpegBase64 ?? null }),
              (err: unknown) => reply({ type: "cofounder_frame", jpegBase64: null, error: err instanceof Error ? err.message : String(err) }),
            );
          break;
        }
        case "voice_mute":
          if (typeof msg.muted === "boolean") opts.mute?.set(msg.muted);
          break;
        case "talk_to":
          if (msg.to === "jev" || msg.to === "cofounder") setTalkingTo(msg.to);
          break;
        case "cofounder_say": {
          const text = String(msg.text ?? "").trim().slice(0, 4000);
          if (!text) break;
          hub.broadcastAll({ type: "notice", from: "→ You, to the co-founder", text, level: "ok" });
          const status = toCofounder(text);
          if (status !== "Sent to the co-founder.") hub.broadcastAll({ type: "notice", from: "↩ The co-founder", text: status, level: "warn" });
          break;
        }
        case "cofounder_history": {
          // To this socket only: the chat box that asked.
          const reply = (m: ServerMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
          if (!opts.cofounder) reply({ type: "cofounder_history", error: "The co-founder isn't connected: Jev needs ORGO_API_KEY in its .env." });
          else if (historyBusy.has(ws)) break; // one read at a time per panel
          else {
            historyBusy.add(ws);
            opts.cofounder
              .deliveries(12)
              .then(
                (all) => reply({ type: "cofounder_history", exchanges: all.filter((d) => d.sender === "user" && d.recipient === "default") }),
                (err: unknown) => reply({ type: "cofounder_history", error: err instanceof Error ? err.message : String(err) }),
              )
              .finally(() => historyBusy.delete(ws));
          }
          break;
        }
        case "listen_mode":
          if (msg.mode === "push" || msg.mode === "wake") writeState({ listenMode: msg.mode });
          break;
      }
    });
    ws.on("close", () => hub.detach(ws));
  });

  const servers: http.Server[] = [];
  const makeServer = () => {
    const server = http.createServer(app);
    server.on("upgrade", (req, socket, head) => {
      const pathname = req.url?.split("?")[0];
      const target = pathname === "/ws" ? wss : pathname === "/ws/stt" ? sttWss : pathname === "/ws/bridge" ? bridgeWss : null;
      if (!target) return socket.destroy();
      const allowed = target === bridgeWss ? tokenPresented(req, auth) : socketAllowed(req, auth, origins);
      if (!allowed) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        return socket.destroy();
      }
      target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
    });
    return server;
  };

  const listenOn = (server: http.Server, host: string, port: number) =>
    new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve((server.address() as AddressInfo).port);
      });
    });

  return {
    hub,
    auth,
    async listen(port) {
      const v4 = makeServer();
      const bound = await listenOn(v4, "127.0.0.1", port);
      servers.push(v4);
      try {
        const v6 = makeServer();
        await listenOn(v6, "::1", bound);
        servers.push(v6);
      } catch {
        /* no IPv6 loopback on this machine */
      }
      origins = allowedOrigins(bound, opts.extraOrigins);
      await phone?.listen(opts.phone?.port ?? bound + 1);
      return bound;
    },
    register(executor) {
      hub.register(executor);
    },
    async refreshOutputDevice() {
      await device?.refresh();
    },
    announce,
    async close() {
      await phone?.close();
      if (typeof unsubAssistantPause === "function") unsubAssistantPause();
      await opts.assistant?.close();
      device?.stop();
      unsubMute?.();
      unsubBridge?.();
      for (const ws of wss.clients) ws.terminate();
      for (const ws of sttWss.clients) ws.terminate();
      for (const ws of bridgeWss.clients) ws.terminate();
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      await hub.close();
    },
  };
}
