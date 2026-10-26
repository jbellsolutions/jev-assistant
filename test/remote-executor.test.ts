import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { HeuristicDecider } from "../core/decide.js";
import type { ServerMessage } from "../core/protocol.js";
import { BRIDGE_PROTOCOL, type FromBridge, type ToBridge } from "../core/remote.js";
import { type Companion, createCompanion } from "../server/companion.js";
import { NO_BACKGROUND_TAB, NOT_CONNECTED, OUT_OF_DATE, RemoteExecutor } from "../server/executors/remote.js";
import { waitFor } from "./helpers/fake-brain.js";
import { FakeExecutor, el } from "./helpers/fake-executor.js";

const TOKEN = "bridge-token-123";
let companion: Companion | null = null;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    ws.on("error", () => {});
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) ws.terminate();
  }
  await companion?.close();
  companion = null;
});

/** A stand-in for the extension: answers exec_reqs from a script the test supplies. */
class FakeBridge {
  ws: WebSocket;
  requests: Array<Extract<ToBridge, { type: "exec_req" }>> = [];
  pings = 0;
  answer: (req: Extract<ToBridge, { type: "exec_req" }>) => FromBridge | null;
  constructor(url: string, answer: FakeBridge["answer"]) {
    this.answer = answer;
    this.ws = new WebSocket(url);
    this.ws.on("error", () => {});
    sockets.push(this.ws);
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as ToBridge;
      if (msg.type === "ping") {
        this.pings++;
        return this.send({ type: "pong" });
      }
      this.requests.push(msg);
      const res = this.answer(msg);
      if (res) this.send(res);
    });
  }
  send(msg: FromBridge) {
    this.ws.send(JSON.stringify(msg));
  }
  open() {
    return new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
      this.ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }
  hello(tab = { url: "https://slack.com/client", title: "Slack" }, protocol = BRIDGE_PROTOCOL) {
    this.send({ type: "hello", protocol, agent: "fake/0", tab });
  }
}

const echo: FakeBridge["answer"] = (m) => {
  switch (m.req.op) {
    case "snapshot":
      return { type: "exec_res", id: m.id, ok: true, result: { op: "snapshot", snapshot: { url: "https://slack.com/client", title: "Slack", elements: [{ tag: "a", role: "", type: "", text: "content", label: "", placeholder: "", name: "", hrefShort: "/content", inViewport: true }] } } };
    case "execute":
      return m.req.action.kind === "click" && m.req.action.elementId === "e9"
        ? { type: "exec_res", id: m.id, ok: false, error: `${m.req.action.label} is no longer on the page` }
        : { type: "exec_res", id: m.id, ok: true, result: { op: "execute", status: `did ${m.req.action.kind}` } };
    case "screenshot":
      return { type: "exec_res", id: m.id, ok: true, result: { op: "screenshot", jpegBase64: Buffer.from("JPEG").toString("base64") } };
    case "read":
      return { type: "exec_res", id: m.id, ok: true, result: { op: "read", page: { text: "Pricing: $42 a month", truncated: false, chars: 20 } } };
    case "tab":
      return { type: "exec_res", id: m.id, ok: true, result: { op: "tab", tab: { url: "https://slack.com/client", title: "Slack" } } };
  }
};

async function boot(opts: { timeoutMs?: number; pingMs?: number } = {}) {
  const readiness: boolean[] = [];
  const bridge = new RemoteExecutor({ timeoutMs: opts.timeoutMs ?? 2000, pingMs: opts.pingMs, onReady: (r) => readiness.push(r) });
  companion = createCompanion({ decider: new HeuristicDecider(), token: TOKEN, bridge });
  const port = await companion.listen(0);
  companion.register(bridge);
  const playwright = new FakeExecutor([el("e0", { text: "Pricing" })], "playwright");
  companion.register(playwright);
  const url = (token: string | null) => `ws://127.0.0.1:${port}/ws/bridge${token ? `?token=${token}` : ""}`;
  return { bridge, port, url, readiness, hub: companion.hub, playwright };
}

describe("RemoteExecutor over /ws/bridge", () => {
  it("refuses a bridge without the token, even from an extension origin", async () => {
    const { url } = await boot();
    const bare = new FakeBridge(url(null), echo);
    await expect(bare.open()).rejects.toThrow(/403/);
    const wrong = new WebSocket(url("nope"), { headers: { origin: "chrome-extension://abc" } });
    sockets.push(wrong);
    await expect(new Promise((_, reject) => wrong.once("unexpected-response", (_r, res) => reject(new Error(`HTTP ${res.statusCode}`))))).rejects.toThrow(/403/);
  });

  it("refuses every bridge when no token is configured at all", async () => {
    const bridge = new RemoteExecutor();
    companion = createCompanion({ decider: new HeuristicDecider(), bridge });
    const port = await companion.listen(0);
    companion.register(bridge);
    const any = new FakeBridge(`ws://127.0.0.1:${port}/ws/bridge`, echo);
    await expect(any.open()).rejects.toThrow(/403/);
    expect(bridge.ready).toBe(false);
  });

  it("is not ready until a bridge attaches; then Chrome becomes the default surface", async () => {
    const { bridge, url, readiness, hub } = await boot();
    expect(bridge.ready).toBe(false);
    expect(hub.defaultId).toBe("playwright");
    await expect(bridge.execute({ kind: "scroll", direction: "down" })).rejects.toThrow(NOT_CONNECTED);
    expect(await bridge.screenshot()).toBeNull();
    const fake = new FakeBridge(url(TOKEN), echo);
    await fake.open();
    fake.hello();
    await waitFor(() => bridge.ready);
    expect(hub.defaultId).toBe("chrome");
    expect(readiness).toEqual([true]);
    await waitFor(() => bridge.url === "https://slack.com/client");
    expect(await bridge.title()).toBe("Slack");
    const statuses = await hub.statuses();
    expect(statuses.find((s) => s.id === "chrome")).toMatchObject({ kind: "chrome", ready: true, url: "https://slack.com/client" });
  });

  it("round-trips snapshot, execute and screenshot; a stale element id surfaces as the shared contract", async () => {
    const { bridge, url } = await boot();
    const fake = new FakeBridge(url(TOKEN), echo);
    await fake.open();
    fake.hello();
    await waitFor(() => bridge.ready);
    const snap = await bridge.snapshot();
    expect(snap).toEqual({ url: "https://slack.com/client", title: "Slack", elements: [{ id: "e0", tag: "a", role: "", type: "", text: "content", label: "", placeholder: "", name: "", hrefShort: "/content", inViewport: true }] });
    expect(await bridge.execute({ kind: "click", elementId: "e0", label: "content" })).toBe("did click");
    await expect(bridge.execute({ kind: "click", elementId: "e9", label: "gone" })).rejects.toThrow("gone is no longer on the page");
    expect(Buffer.from((await bridge.screenshot())!).toString()).toBe("JPEG");
    expect(fake.requests.map((r) => r.req.op)).toEqual(["snapshot", "execute", "execute", "screenshot"]);
    expect(await bridge.setViewport()).toBe(false);
  });

  it("reads page text from a current bridge", async () => {
    const { bridge, url } = await boot();
    const fake = new FakeBridge(url(TOKEN), echo);
    await fake.open();
    fake.hello();
    // `ready` only means the socket attached; wait for the hello itself to be processed
    await waitFor(() => bridge.url === "https://slack.com/client");
    expect(bridge.capabilities.read).toBe(true);
    expect(await bridge.read()).toEqual({ url: "https://slack.com/client", title: "Slack", text: "Pricing: $42 a month", truncated: false, chars: 20 });
  });

  it("reports an out-of-date bridge instead of sending it an op it cannot answer", async () => {
    const { bridge, url } = await boot();
    const fake = new FakeBridge(url(TOKEN), echo);
    await fake.open();
    fake.hello(undefined, 1); // a bridge built before the read op existed
    await waitFor(() => bridge.url === "https://slack.com/client");
    expect(bridge.capabilities.read).toBe(false);
    // the fix is one click in chrome://extensions, so it has to reach the caller, not just a throw
    expect(bridge.readHint).toBe(OUT_OF_DATE);
    await expect(bridge.read()).rejects.toThrow("out of date");
    expect(fake.requests).toHaveLength(0);
  });

  it("never sends the user's panel typing to a bridge that would overwrite a field with it", async () => {
    // A protocol-3 extension ignores `focused` and types into the page's first field, replacing it.
    const { bridge, url } = await boot();
    const fake = new FakeBridge(url(TOKEN), echo);
    await fake.open();
    fake.hello(undefined, 3);
    await waitFor(() => bridge.url === "https://slack.com/client");
    await expect(bridge.execute({ kind: "type", elementId: null, label: null, text: "hi", submit: false, focused: true })).rejects.toThrow("out of date");
    await expect(bridge.execute({ kind: "click_at", x: 1, y: 1, fx: 0.5, fy: 0.5 })).rejects.toThrow("out of date");
    expect(fake.requests).toHaveLength(0);
    expect(await bridge.execute({ kind: "scroll", direction: "down" })).toBe("did scroll"); // everything else still works
  });

  it("tells every panel which extension is connected, so an old build can't hide", async () => {
    const { port, url, bridge } = await boot();
    const panel = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
    sockets.push(panel);
    const seen: ServerMessage[] = [];
    panel.on("message", (raw) => seen.push(JSON.parse(String(raw)) as ServerMessage));
    await new Promise<void>((r) => panel.once("open", () => r()));
    await waitFor(async () => seen.some((m) => m.type === "hello"), 2000);
    expect(seen.find((m): m is Extract<ServerMessage, { type: "hello" }> => m.type === "hello")!.bridge).toBeNull();

    const fake = new FakeBridge(url(TOKEN), echo);
    await fake.open();
    fake.hello(undefined, 2); // the stale jev-automation build the user's Chrome was loading
    const last = () => [...seen].reverse().find((m): m is Extract<ServerMessage, { type: "bridge" }> => m.type === "bridge")?.bridge;
    await waitFor(async () => last()?.protocol === 2, 2000);
    expect(last()).toEqual({ protocol: 2, current: BRIDGE_PROTOCOL });
    const { sessions } = (await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { sessions: Array<{ id: string; protocol?: number }> };
    expect(sessions.find((x) => x.id === bridge.id)?.protocol).toBe(2);

    fake.ws.close();
    await waitFor(async () => last() === null, 2000);
  });

  it("offers no reload hint when no bridge is attached at all", async () => {
    const { bridge } = await boot();
    expect(bridge.readHint).toBeNull();
  });

  it("times out an unanswered request and fails in-flight ones when the bridge drops", async () => {
    const { bridge, url, readiness, hub } = await boot({ timeoutMs: 150 });
    const mute = new FakeBridge(url(TOKEN), () => null);
    await mute.open();
    mute.hello();
    await waitFor(() => bridge.ready);
    await expect(bridge.execute({ kind: "reload" })).rejects.toThrow(/didn't answer within/);
    const hanging = bridge.execute({ kind: "back" });
    mute.ws.close();
    await expect(hanging).rejects.toThrow(/Chrome disconnected/);
    await waitFor(() => !bridge.ready);
    expect(readiness).toEqual([true, false]);
    expect(hub.defaultId).toBe("playwright");
  });

  it("keeps a healthy bridge when a duplicate connects, and accepts a reconnect after it closes", async () => {
    const { bridge, url } = await boot();
    let changes = 0;
    bridge.onChange(() => changes++);
    const a = new FakeBridge(url(TOKEN), echo);
    await a.open();
    a.hello();
    await waitFor(() => bridge.ready);
    a.send({ type: "tab", tab: { url: "https://mail.google.com/", title: "Inbox" } });
    await waitFor(() => bridge.url === "https://mail.google.com/");
    expect(changes).toBeGreaterThanOrEqual(2);
    const b = new FakeBridge(url(TOKEN), echo);
    const duplicateClosed = new Promise<number>((r) => b.ws.once("close", (code) => r(code)));
    await b.open();
    expect(await duplicateClosed).toBe(1013);
    expect(bridge.ready).toBe(true);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    expect(bridge.url).toBe("https://mail.google.com/");
    const result = await bridge.execute({ kind: "reload" });
    expect(result).toBe("did reload");
    expect(b.requests).toHaveLength(0);
    a.ws.close();
    await waitFor(() => !bridge.ready);
    const c = new FakeBridge(url(TOKEN), echo);
    await c.open(); c.hello();
    await waitFor(() => bridge.ready);
    expect(await bridge.execute({ kind: "back" })).toBe("did back");
  });

  it("a duplicate does not take ownership of an action already in flight", async () => {
    const { bridge, url } = await boot();
    const owner = new FakeBridge(url(TOKEN), () => null);
    await owner.open(); owner.hello();
    await waitFor(() => bridge.ready);
    const result = bridge.execute({ kind: "scroll", direction: "down" });
    await waitFor(() => owner.requests.length === 1);
    const duplicate = new FakeBridge(url(TOKEN), echo);
    const closed = new Promise<void>((r) => duplicate.ws.once("close", () => r()));
    await duplicate.open(); await closed;
    owner.send({ type: "exec_res", id: owner.requests[0]!.id, ok: true, result: { op: "execute", status: "Scrolled on the original page" } });
    expect(await result).toBe("Scrolled on the original page");
    expect(duplicate.requests).toHaveLength(0);
  });

  it("drops a bridge that stops answering pings", async () => {
    const { bridge, url } = await boot({ pingMs: 40 });
    const deaf = new WebSocket(url(TOKEN));
    sockets.push(deaf);
    await new Promise<void>((r) => deaf.once("open", () => r()));
    await waitFor(() => bridge.ready);
    await waitFor(() => !bridge.ready, 2000);
  });

  it("UI sockets follow the default surface when the bridge comes and goes", async () => {
    const { bridge, url, port, hub, playwright } = await boot();
    const ui = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
    sockets.push(ui);
    const hellos: ServerMessage[] = [];
    ui.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as ServerMessage;
      if (m.type === "hello") hellos.push(m);
    });
    await waitFor(() => hellos.length === 1);
    const fake = new FakeBridge(url(TOKEN), echo);
    await fake.open();
    fake.hello();
    await waitFor(() => bridge.ready);
    hub.followDefault();
    await waitFor(() => hellos.length === 2);
    ui.send(JSON.stringify({ type: "command", text: "scroll down" }));
    await waitFor(() => fake.requests.some((r) => r.req.op === "execute"));
    expect(playwright.executed).toEqual([]);
    fake.ws.close();
    await waitFor(() => !bridge.ready);
    hub.followDefault();
    await waitFor(() => hellos.length === 3);
    ui.send(JSON.stringify({ type: "command", text: "scroll down" }));
    await waitFor(() => playwright.executed.length === 1);
  });
});

describe("Jev's own background window of the user's Chrome", () => {
  it("aims every request at Jev's tab, while the plain bridge keeps using the tab he is looking at", async () => {
    const { bridge, url } = await boot();
    const fake = new FakeBridge(url(TOKEN), echo);
    await fake.open();
    fake.hello();
    await waitFor(() => bridge.protocol === BRIDGE_PROTOCOL);
    const jev = bridge.jevTab();
    await jev.snapshot();
    await jev.execute({ kind: "navigate", url: "https://mail.google.com" });
    const text = await jev.read!(1000);
    expect(text.text).toContain("$42");
    // snapshot · execute + where it landed · read + tab
    expect(fake.requests.map((r) => `${r.req.op}:${r.req.tab}`)).toEqual(["snapshot:jev", "execute:jev", "tab:jev", "read:jev", "tab:jev"]);
    await bridge.snapshot();
    expect(fake.requests.at(-1)!.req.tab).toBeUndefined();
    expect(await jev.screenshot()).toBeNull(); // minimized: nothing to capture, and nothing asked of the bridge
  });

  it("refuses to work through an older extension, which would ignore the target and act in his tab", async () => {
    const { bridge, url } = await boot();
    const fake = new FakeBridge(url(TOKEN), echo);
    await fake.open();
    fake.hello(undefined, 2);
    await waitFor(() => bridge.protocol === 2);
    const jev = bridge.jevTab();
    await expect(jev.snapshot()).rejects.toThrow(NO_BACKGROUND_TAB);
    await expect(jev.execute({ kind: "navigate", url: "https://x.test" })).rejects.toThrow(NO_BACKGROUND_TAB);
    expect(jev.readHint).toBe(NO_BACKGROUND_TAB);
    expect(fake.requests).toHaveLength(0);
  });
});
