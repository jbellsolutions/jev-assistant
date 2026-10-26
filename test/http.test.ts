import { mkdtempSync } from "node:fs";
import { MuteSwitch } from "../server/speak/gate.js";
import { readState } from "../server/state.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { HeuristicDecider } from "../core/decide.js";
import type { ServerMessage } from "../core/protocol.js";
import type { CommandResult } from "../core/results.js";
import { AttachmentStore } from "../server/attachments.js";
import { type Companion, createCompanion } from "../server/companion.js";
import { FakeBrain, tick, waitFor } from "./helpers/fake-brain.js";
import { FakeExecutor, el } from "./helpers/fake-executor.js";
import type { Speaker } from "../core/speak.js";

process.env.JEV_HOME = mkdtempSync(path.join(tmpdir(), "jev-home-")); // the listening mode is persisted; never into ~/.jev

const TOKEN = "test-token-123";
let companion: Companion | null = null;

async function boot(opts: { token?: string; elements?: Parameters<typeof el>[1][]; brain?: FakeBrain; sttListener?: boolean; speaker?: Speaker | null; voiceDescription?: string; outputDevice?: () => Promise<string | null>; mute?: MuteSwitch; cofounder?: unknown; attachments?: AttachmentStore } = {}) {
  const executor = new FakeExecutor((opts.elements ?? []).map((o, i) => el(`e${i}`, o)), "playwright");
  const listener = opts.sttListener ? ({ name: "apple", open: () => ({ send: () => {}, finish: () => {}, close: () => {} }) } as unknown as Parameters<typeof createCompanion>[0]["sttListener"]) : null;
  companion = createCompanion({ decider: new HeuristicDecider(), token: "token" in opts ? opts.token : TOKEN, brain: opts.brain, sttListener: listener, ...(opts.speaker ? { speaker: opts.speaker } : {}), ...(opts.voiceDescription ? { voiceDescription: opts.voiceDescription } : {}), ...(opts.outputDevice ? { outputDevice: opts.outputDevice } : {}), ...(opts.mute ? { mute: opts.mute } : {}), ...(opts.cofounder ? { cofounder: opts.cofounder as never } : {}), ...(opts.attachments ? { attachments: opts.attachments } : {}) });
  const port = await companion.listen(0);
  companion.register(executor);
  const base = `http://127.0.0.1:${port}`;
  const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
  const post = (path: string, body: unknown, token: string | null = TOKEN) => call(path, { method: "POST", body: JSON.stringify(body) }, token);
  return { executor, port, base, call, post };
}

afterEach(async () => {
  await companion?.close();
  companion = null;
});

describe("HTTP API: pause switch", () => {
  it("refuses commands and asks with 409 while paused, and reports the switch", async () => {
    const { call, post, executor } = await boot({ brain: new FakeBrain() });
    expect((await post("/api/pause", { paused: true })).status).toBe(200);
    expect(await (await call("/api/health", {}, null)).json()).toMatchObject({ paused: true });
    const r = await post("/api/command", { text: "scroll down" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/paused/);
    expect(executor.executed).toEqual([]);
    await post("/api/pause", { paused: false });
    expect((await post("/api/command", { text: "scroll down" })).status).toBe(200);
    expect(executor.executed.map((a) => a.kind)).toEqual(["scroll"]);
  });
});

describe("HTTP API", () => {
  it("serves health without a token", async () => {
    const { call } = await boot();
    const r = await call("/api/health", {}, null);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, jev: { enabled: false }, sessions: ["playwright"] });
  });

  it("rejects missing and wrong tokens", async () => {
    const { call, post } = await boot();
    expect((await call("/api/sessions", {}, null)).status).toBe(401);
    expect((await post("/api/command", { text: "open a.com" }, "nope")).status).toBe(401);
  });

  it("refuses everything but health when no token is configured", async () => {
    const { call, executor } = await boot({ token: undefined });
    const r = await call("/api/sessions", {}, "anything");
    expect(r.status).toBe(401);
    expect((await r.json()).error).toMatch(/JEV_TOKEN/);
    expect(executor.executed).toEqual([]);
  });

  it("runs a multi-step command and returns every step", async () => {
    const { post, executor } = await boot();
    const r = await post("/api/command", { text: "open wikipedia and scroll down" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as CommandResult;
    expect(body.ok).toBe(true);
    expect(body.steps.map((s) => s.command)).toEqual(["open wikipedia", "scroll down"]);
    expect(body.steps[0]!.decision?.intent).toBe("open_url");
    expect(body.page.url).toBe("https://www.wikipedia.org");
    expect(executor.executed.map((a) => a.kind)).toEqual(["navigate", "scroll"]);
  });

  it("returns a pending confirmation and resolves it through /api/reply", async () => {
    const { post, executor } = await boot({ elements: [{ tag: "button", text: "Delete account" }] });
    const first = (await (await post("/api/command", { text: "click delete account" })).json()) as CommandResult;
    expect(first.pending).toMatchObject({ kind: "confirm" });
    expect(executor.executed).toEqual([]);
    const second = (await (await post("/api/reply", { ok: true })).json()) as CommandResult;
    expect(second.ok).toBe(true);
    expect(executor.executed).toHaveLength(1);
  });

  it("resolves a clarification through /api/reply pick", async () => {
    const { post, executor } = await boot({ elements: [{ text: "Pricing", hrefShort: "/pricing" }, { text: "Pricing FAQ", hrefShort: "/faq" }, { text: "Pricing plans", hrefShort: "/plans" }] });
    const first = (await (await post("/api/command", { text: "click pricing" })).json()) as CommandResult;
    expect(first.pending?.kind).toBe("clarify");
    await post("/api/reply", { pick: "e1" });
    expect(executor.executed).toEqual([{ kind: "click", elementId: "e1", label: 'link "Pricing FAQ" → /faq' }]);
  });

  it("validates input and unknown sessions", async () => {
    const { post } = await boot();
    expect((await post("/api/command", {})).status).toBe(400);
    expect((await post("/api/command", { text: "open a.com", session: "mars" })).status).toBe(404);
    expect((await post("/api/reply", {})).status).toBe(400);
  });

  it("/api/read returns the page's prose, capped on request", async () => {
    const { post } = await boot();
    const r = await post("/api/read", {});
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ text: "The Pro plan costs $42 per month.", truncated: false, chars: 33 });

    const capped = await (await post("/api/read", { max: 8 })).json();
    expect(capped).toMatchObject({ text: "The Pro ", truncated: true, chars: 33 });

    await post("/api/pause", { paused: true });
    expect((await post("/api/read", {})).status).toBe(409);
  });

  it("/api/read says so when the surface cannot read, and 404s an unknown session", async () => {
    const { post, executor } = await boot();
    expect((await post("/api/read", { session: "mars" })).status).toBe(404);
    executor.capabilities.read = false;
    const r = await post("/api/read", {});
    expect(r.status).toBe(422);
    expect((await r.json()).error).toMatch(/cannot read page text/);
  });

  it("/api/read passes on the surface's own explanation when it has one", async () => {
    const { post, executor } = await boot();
    executor.capabilities.read = false;
    executor.readHint = "reload the extension";
    expect((await (await post("/api/read", {})).json()).error).toBe("reload the extension");
  });

  it("no API route reaches the brain: /api/ask is gone and /api/command stays local", async () => {
    // The v10 jev_ask loop: a question the brain asked Jev came back round as a steer into the
    // brain's own run. The route that made that possible no longer exists, and /command is local.
    const brain = new FakeBrain();
    const { post } = await boot({ brain });
    expect((await post("/api/ask", { text: "what's on my calendar" })).status).toBe(404);
    await post("/api/command", { text: "what's on my calendar" });
    await tick();
    expect(brain.sent).toEqual([]);
    expect(brain.steers).toEqual([]);
  });

  it("/api/approve answers the brain's approval requests", async () => {
    const brain = new FakeBrain();
    const { post, port } = await boot({ brain });
    // started the way a human starts one — the panel — now that a tool call cannot
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "command", text: "what's on my calendar" }));
    await waitFor(() => brain.sent.length === 1);
    brain.emit("run_1", { kind: "approval", requestId: "r1", summary: "read your calendar", choices: ["once", "deny"] });
    await tick();
    expect((await post("/api/approve", { choice: "maybe" })).status).toBe(400);
    expect((await post("/api/approve", { choice: "once" })).status).toBe(200);
    expect(brain.approvals).toEqual([{ runId: "run_1", choice: "once", requestId: "r1" }]);
    ws.close();
  });

  it("a file dropped on the panel: uploaded from its origin, sent with the message — and a made-up id never reaches the brain", async () => {
    const brain = new FakeBrain();
    const { port, base } = await boot({ brain, attachments: new AttachmentStore(mkdtempSync(path.join(tmpdir(), "jev-att-"))) });
    const origin = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/attachments`, { method: "POST", headers: { "x-file-name": "plan.md", origin: "https://evil.example" }, body: "# Plan" })).status).toBe(401);
    const up = await fetch(`${base}/attachments`, { method: "POST", headers: { "x-file-name": "plan.md", origin }, body: "# Plan" });
    const { id } = (await up.json()) as { id: string };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin } });
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "command", text: "do phase 1", attachments: [{ id, name: "renamed.md" }, { id: "att_madeup", name: "x" }, { id: "../../etc/passwd", name: "y" }] }));
    await waitFor(() => brain.sent.length === 1);
    expect(brain.attached[0]).toEqual([{ id, name: "plan.md" }]);
    ws.close();
  });

  it("lists sessions", async () => {
    const { call } = await boot();
    const body = await (await call("/api/sessions")).json();
    expect(body.default).toBe("playwright");
    expect(body.sessions[0]).toMatchObject({ id: "playwright", kind: "playwright", busy: false, pending: null });
  });
});

describe("WebSocket origin check", () => {
  const open = (port: number, origin?: string, token?: string) =>
    new Promise<{ ok: boolean; first?: unknown }>((resolve) => {
      const headers: Record<string, string> = {};
      if (origin) headers.origin = origin;
      if (token) headers.authorization = `Bearer ${token}`;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
      ws.once("message", (data) => {
        resolve({ ok: true, first: JSON.parse(String(data)) });
        ws.close();
      });
      ws.once("error", () => resolve({ ok: false }));
      ws.once("unexpected-response", () => resolve({ ok: false }));
    });

  it("accepts the companion's own origin, rejects strangers, and makes non-browser clients present the token", async () => {
    const { port } = await boot();
    expect((await open(port, `http://localhost:${port}`)).first).toMatchObject({ type: "hello" });
    expect((await open(port, "https://evil.example")).ok).toBe(false);
    expect((await open(port)).ok).toBe(false);
    expect((await open(port, undefined, "wrong")).ok).toBe(false);
    expect((await open(port, undefined, TOKEN)).ok).toBe(true);
  });

  it("lets non-browser clients in without a token only when none is configured", async () => {
    const { port } = await boot({ token: undefined });
    expect((await open(port)).ok).toBe(true);
  });

  it("listens on IPv6 loopback too when available", async () => {
    const { port } = await boot();
    const r = await fetch(`http://[::1]:${port}/api/health`).catch(() => null);
    if (r) expect(r.status).toBe(200);
  });
});

describe("HTTP API: the panel is told whether Jev has a voice", () => {
  /** Reads the first hello a real UI socket receives, exactly as the panel does. */
  const hello = async (port: number) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
    const msg = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once("error", reject);
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw)) as Record<string, unknown>;
        if (m.type === "hello") resolve(m);
      });
    });
    ws.close();
    return msg;
  };

  it("says off, and why, when no key is set — silence with a reason instead of silence", async () => {
    // this is the whole point: "no audio" and "no API key" were indistinguishable from the panel,
    // because the only thing that said so was stdout, which a Dock-launched app does not have
    const { port } = await boot();
    const m = (await hello(port)).voice as { on: boolean; detail: string };
    expect(m.on).toBe(false);
    expect(m.detail).toMatch(/FISH_AUDIO_API_KEY/);
  });

  it("says which voice when there is one, in the same words the startup log used", async () => {
    const speaker: Speaker = { speak: async () => {}, stop: () => {} };
    const { port } = await boot({ speaker, voiceDescription: "voice out: fish (s2.1-pro-free, via ffplay)" });
    const m = (await hello(port)).voice as { on: boolean; detail: string };
    expect(m.on).toBe(true);
    // the "voice out: " prefix belongs to the log line, not to a pill three words wide
    expect(m.detail).toBe("fish (s2.1-pro-free, via ffplay)");
  });

  it("reports the speaker the hub actually holds, not a second reading of the environment", async () => {
    // a speaker was wired in; if this asked the env again it would answer "off" and the panel would
    // claim silence while Jev was audibly talking
    const speaker: Speaker = { speak: async () => {}, stop: () => {} };
    const { port } = await boot({ speaker });
    expect(((await hello(port)).voice as { on: boolean }).on).toBe(true);
  });

  it("names the Mac's output device, because Jev's voice goes wherever that points", async () => {
    // The headset case: output had drifted to the Mac mini speakers and nothing on screen said so.
    const speaker: Speaker = { speak: async () => {}, stop: () => {} };
    const { port } = await boot({ speaker, outputDevice: async () => "Soundcore Headphones" });
    await waitFor(async () => ((await hello(port)).voice as { device?: string }).device === "Soundcore Headphones", 2000);
  });

  it("tells an open panel when the output device changes, without a reload", async () => {
    let device = "Soundcore Headphones";
    const { port } = await boot({ outputDevice: async () => device });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
    const seen: ServerMessage[] = [];
    ws.on("message", (d) => seen.push(JSON.parse(String(d)) as ServerMessage));
    await new Promise<void>((r) => ws.once("open", () => r()));
    device = "Mac mini Speakers";
    // the companion's poller is on a 10s timer; drive a read directly through the same path
    await companion!.refreshOutputDevice();
    await waitFor(async () => seen.some((m) => m.type === "voice" && m.voice.device === "Mac mini Speakers"), 2000);
    ws.close();
  });
});

describe("how Jev listens, over the socket", () => {
  /** Open a panel socket and collect what it is told. */
  const panel = async (port: number) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
    const seen: ServerMessage[] = [];
    ws.on("message", (d) => seen.push(JSON.parse(String(d)) as ServerMessage));
    await new Promise<void>((r) => ws.once("open", () => r()));
    await waitFor(async () => seen.some((m) => m.type === "hello"), 2000);
    return { ws, seen, hello: () => seen.find((m): m is Extract<ServerMessage, { type: "hello" }> => m.type === "hello")! };
  };

  it("offers the switch only when the free on-device recogniser is really there", async () => {
    // A switch that cannot work is worse than no switch: wake mode is refused by the relay without a
    // listener, so the panel must not present it as a choice.
    const off = await boot();
    const a = await panel(off.port);
    expect(a.hello().listen).toEqual({ mode: "push", wakeAvailable: false });
    a.ws.close();
    await companion?.close();

    const on = await boot({ sttListener: true });
    const b = await panel(on.port);
    expect(b.hello().listen).toEqual({ mode: "push", wakeAvailable: true });
    b.ws.close();
  });

  it("remembers the choice, and tells the next panel that opens", async () => {
    // Persisted server-side on purpose: there is no localStorage anywhere in client/src, and the
    // choice has to survive a relaunch.
    const { port } = await boot({ sttListener: true });
    const first = await panel(port);
    first.ws.send(JSON.stringify({ type: "listen_mode", mode: "wake" }));
    await new Promise((r) => setTimeout(r, 150));
    first.ws.close();

    const second = await panel(port);
    expect(second.hello().listen).toMatchObject({ mode: "wake" });
    second.ws.close();
  });

  it("ignores a mode it does not know rather than storing it", async () => {
    const { port } = await boot({ sttListener: true });
    const a = await panel(port);
    a.ws.send(JSON.stringify({ type: "listen_mode", mode: "wake" }));
    await new Promise((r) => setTimeout(r, 120));
    a.ws.send(JSON.stringify({ type: "listen_mode", mode: "telepathy" }));
    await new Promise((r) => setTimeout(r, 120));
    a.ws.close();
    const b = await panel(port);
    expect(b.hello().listen).toMatchObject({ mode: "wake" });
    b.ws.close();
  });
});

describe("companion: mute", () => {
  const speaker: Speaker = { speak: async () => {}, stop: () => {} };
  const panel = async (port: number) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { headers: { origin: `http://127.0.0.1:${port}` } });
    const seen: ServerMessage[] = [];
    ws.on("message", (d) => seen.push(JSON.parse(String(d)) as ServerMessage));
    await new Promise<void>((r) => ws.once("open", () => r()));
    await waitFor(async () => seen.some((m) => m.type === "hello"), 2000);
    return { ws, seen };
  };
  const lastVoice = (seen: ServerMessage[]) => [...seen].reverse().map((m) => (m.type === "voice" ? m.voice : m.type === "hello" ? m.voice : undefined)).find(Boolean);

  it("the pill mutes, every panel hears it, and it is remembered", async () => {
    const mute = new MuteSwitch(false);
    const { port } = await boot({ speaker, mute });
    const a = await panel(port);
    const b = await panel(port);
    expect(lastVoice(a.seen)).toMatchObject({ on: true, muted: false });
    a.ws.send(JSON.stringify({ type: "voice_mute", muted: true }));
    await waitFor(async () => lastVoice(b.seen)?.muted === true, 2000);
    expect(mute.muted).toBe(true);
    expect(readState().muted).toBe(true);
    a.ws.send(JSON.stringify({ type: "voice_mute", muted: "yes" })); // not a boolean: ignored
    await new Promise((r) => setTimeout(r, 100));
    expect(mute.muted).toBe(true);
    a.ws.close();
    b.ws.close();
  });

  it("\"voice on\" said to Jev flips the same switch", async () => {
    const mute = new MuteSwitch(true);
    const { port, post } = await boot({ speaker, mute });
    const a = await panel(port);
    await post("/api/command", { text: "voice on" });
    await waitFor(async () => lastVoice(a.seen)?.muted === false, 2000);
    expect(readState().muted).toBe(false);
    a.ws.close();
  });
});

describe("companion: the bridge's readiness check", () => {
  it("always answers 200 and says whether the token is right, so Chrome logs nothing", async () => {
    const { port } = await boot();
    const ask = (auth?: string) => fetch(`http://127.0.0.1:${port}/api/bridge-ready`, auth ? { headers: { authorization: auth } } : {});
    for (const [auth, token] of [[`Bearer ${TOKEN}`, "ok"], ["Bearer nope", "wrong"], [undefined, "wrong"]] as const) {
      const res = await ask(auth);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, token });
    }
  });

  it("says unset when Jev has no token, since the bridge socket is then refused outright", async () => {
    const { port } = await boot({ token: undefined });
    expect(await (await fetch(`http://127.0.0.1:${port}/api/bridge-ready`, { headers: { authorization: "Bearer x" } })).json()).toEqual({ ok: true, token: "unset" });
  });
});

describe("companion: announcements", () => {
  it("speaks a long late reply only up to the voice's limit; the panel keeps all of it", async () => {
    const said: string[] = [];
    const speaker: Speaker = { maxChars: 120, speak: async (t) => void said.push(t), stop: () => {} };
    await boot({ speaker });
    const long = `The co-founder replied. ${"It checked every listing and found the numbers line up. ".repeat(40)}`;
    companion!.announce("↩ The co-founder replied", long, "ok", long);
    expect(said).toHaveLength(1);
    expect(said[0]!.length).toBeLessThanOrEqual(120);
  });
});

describe("companion: the co-founder's desktop", () => {
  const panel = async (port: number) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { headers: { origin: `http://127.0.0.1:${port}` } });
    const seen: ServerMessage[] = [];
    ws.on("message", (d) => seen.push(JSON.parse(String(d)) as ServerMessage));
    await new Promise<void>((r) => ws.once("open", () => r()));
    await waitFor(async () => seen.some((m) => m.type === "hello"), 2000);
    return { ws, seen, hello: () => seen.find((m): m is Extract<ServerMessage, { type: "hello" }> => m.type === "hello")! };
  };

  it("says why there is no desktop when Orgo isn't configured", async () => {
    const { port } = await boot();
    const a = await panel(port);
    expect(a.hello().cofounder).toEqual({ off: expect.stringContaining("ORGO_API_KEY") });
    a.ws.send(JSON.stringify({ type: "cofounder_view" }));
    await waitFor(async () => a.seen.some((m) => m.type === "cofounder_view"), 2000);
    expect(a.seen.find((m) => m.type === "cofounder_view")).toMatchObject({ error: expect.stringContaining("ORGO_API_KEY") });
    a.ws.close();
  });

  it("gives the desktop's password to the panel that asked, and to no other", async () => {
    const cofounder = { computerId: "00000000-0000-4000-8000-000000000000", view: async () => ({ wsUrl: "wss://x/desktops/d/ws/websockify?token=pw", password: "pw" }) };
    const { port } = await boot({ cofounder });
    const a = await panel(port);
    const b = await panel(port);
    expect(a.hello().cofounder).toEqual({ computer: "00000000-0000-4000-8000-000000000000" });
    a.ws.send(JSON.stringify({ type: "cofounder_view" }));
    await waitFor(async () => a.seen.some((m) => m.type === "cofounder_view"), 2000);
    await new Promise((r) => setTimeout(r, 100));
    expect(b.seen.some((m) => m.type === "cofounder_view")).toBe(false);
    a.ws.close();
    b.ws.close();
  });

  it("talking to the co-founder: the switch reaches every panel; the chat box sends and reads", async () => {
    const sent: string[] = [];
    const cofounder = {
      computerId: "00000000-0000-4000-8000-000000000000",
      send: async (m: string) => (sent.push(m), { id: "x", state: "complete", result: "On it — Monday." }),
      watch: () => {},
      deliveries: async () => [
        { id: "1", sender: "user", recipient: "default", state: "complete", body: "hi", result: "hello", created: 2 },
        { id: "2", sender: "user", recipient: "studio-qa-email", state: "complete", body: "qa", result: "ok", created: 1 },
      ],
    };
    const { port } = await boot({ cofounder });
    const a = await panel(port);
    const b = await panel(port);
    expect(a.hello().talkingTo).toBe("jev");
    a.ws.send(JSON.stringify({ type: "talk_to", to: "cofounder" }));
    await waitFor(async () => b.seen.some((m) => m.type === "talking_to" && m.to === "cofounder"), 2000);

    a.ws.send(JSON.stringify({ type: "cofounder_say", text: "when is the launch?" }));
    await waitFor(async () => a.seen.some((m) => m.type === "notice" && m.text === "On it — Monday."), 2000);
    expect(sent).toEqual(["when is the launch?"]);

    a.ws.send(JSON.stringify({ type: "cofounder_history" }));
    await waitFor(async () => a.seen.some((m) => m.type === "cofounder_history"), 2000);
    // only the user's conversation with the head agent, not the Studio's QA traffic
    expect(a.seen.find((m) => m.type === "cofounder_history")).toMatchObject({ exchanges: [{ id: "1" }] });
    await new Promise((r) => setTimeout(r, 50));
    expect(b.seen.some((m) => m.type === "cofounder_history")).toBe(false);
    a.ws.send(JSON.stringify({ type: "talk_to", to: "jev" })); // leave the saved state as found
    await waitFor(async () => a.seen.some((m) => m.type === "talking_to" && m.to === "jev"), 2000);
    a.ws.close();
    b.ws.close();
  });
});
