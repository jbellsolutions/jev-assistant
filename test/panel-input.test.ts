/** "Your screen": it shows the window Jev is working in, it stays live, and the user can click and
 *  type in it — his own hands, delivered in the background to the window the picture shows. */
import { describe, expect, it } from "vitest";
import type { Action } from "../core/actions.js";
import type { Executor, ExecutorKind } from "../core/executor.js";
import { type MacWindow, pointFor } from "../core/mac.js";
import type { ServerMessage } from "../core/protocol.js";
import { HeuristicDecider } from "../core/decide.js";
import { FrontExecutor } from "../server/executors/front.js";
import { type Driver, FOLLOW_MS, MacExecutor } from "../server/executors/mac.js";
import { Hub } from "../server/hub.js";
import { el } from "./helpers/fake-executor.js";
import { waitFor } from "./helpers/fake-brain.js";

const slack: MacWindow = { app_name: "Slack", pid: 100, window_id: 15, title: "general - Acme", layer: 0, is_on_screen: true, bounds: { x: 0, y: 0, width: 1200, height: 800 } };
const chromeWin: MacWindow = { ...slack, app_name: "Google Chrome", pid: 60, window_id: 16, title: "Inbox" };

function driver(windows: MacWindow[]) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const d: Driver = async (tool, args = {}) => {
    calls.push({ tool, args });
    switch (tool) {
      case "check_permissions":
        return { accessibility: true };
      case "list_windows":
        return { windows };
      case "get_window_state":
        if (args.include_accessibility_tree === false) return { screenshot_width: 600, window_bounds: { x: 0, y: 0, width: 1200, height: 800 } };
        return { snapshot_id: "s1", window_title: "general - Acme", elements: [{ element_index: 3, role: "AXRow", label: "general", actions: ["AXPress"], element_token: "s1:3" }] };
      default:
        return { ok: true };
    }
  };
  return { d, calls };
}

/** Which window the last picture was of: the screenshot call's window. */
const pictured = (calls: Array<{ tool: string; args: Record<string, unknown> }>) => calls.filter((c) => c.tool === "get_window_state" && c.args.max_dimension).at(-1)?.args.window_id;

describe("pointFor", () => {
  it("maps a fraction of the picture into the driver's click space, clamped inside the window", () => {
    // 1200×800 window, driver screenshot 600 wide → 600×400
    expect(pointFor(0.5, 0.5, { width: 1200, height: 800 }, 600)).toEqual({ x: 300, y: 200 });
    expect(pointFor(1.4, -2, { width: 1200, height: 800 }, 600)).toEqual({ x: 599, y: 0 });
  });
});

describe("the Mac picture follows Jev's work", () => {
  it("pictures the app she is working in, even with another in front — then goes back to the front", async () => {
    let now = 1_000_000;
    const { d, calls } = driver([chromeWin, slack]);
    const mac = new MacExecutor({ driver: d, frontPid: async () => 60, now: () => now, screenshotMinIntervalMs: 0 });
    await mac.screenshot();
    expect(pictured(calls)).toBe(16); // Chrome is in front, nothing is being worked on
    await mac.readApp("Slack");
    expect(mac.working).toBe(true);
    await mac.screenshot();
    expect(pictured(calls)).toBe(15); // Slack, behind Chrome
    expect((await mac.frameInfo()).url).toBe("app://Slack");
    now += FOLLOW_MS + 1;
    await mac.screenshot();
    expect(pictured(calls)).toBe(16);
  });
});

describe("the user's hands on the picture", () => {
  it("clicks where he clicked, on the pictured window, in the background", async () => {
    const { d, calls } = driver([slack]);
    const mac = new MacExecutor({ driver: d, frontPid: async () => 100, screenshotMinIntervalMs: 0 });
    await expect(mac.inputClick(0.5, 0.5)).rejects.toThrow(/Nothing on screen yet/);
    await mac.screenshot();
    expect(await mac.inputClick(0.5, 0.5)).toBe("Clicked in Slack");
    expect(calls.find((c) => c.tool === "click")!.args).toEqual({ pid: 100, window_id: 15, x: 300, y: 200, delivery_mode: "background" });
    await mac.inputText("hi there");
    expect(calls.at(-1)).toEqual({ tool: "type_text", args: { pid: 100, window_id: 15, text: "hi there" } });
    await mac.inputKey("Enter");
    expect(calls.at(-1)).toEqual({ tool: "press_key", args: { pid: 100, window_id: 15, key: "return", delivery_mode: "background" } });
  });
});

class Browser implements Executor {
  capabilities = { screenshot: false, viewport: false, clickAt: false, read: false };
  readonly viewport = { width: 1280, height: 800 };
  url = "https://example.test/";
  executed: Action[] = [];
  constructor(readonly kind: ExecutorKind, public ready = true, readonly id = kind) {}
  async start() {}
  async title() {
    return this.kind;
  }
  async snapshot() {
    return { url: this.url, title: this.kind, elements: [el("e0", { text: "Compose" })] };
  }
  async screenshot() {
    return this.capabilities.screenshot ? new Uint8Array([1, 2, 3]) : null;
  }
  async execute(action: Action) {
    this.executed.push(action);
    return `did ${action.kind}`;
  }
  async setViewport() {
    return false;
  }
  onChange(_cb: () => void) {
    return () => {};
  }
  async close() {}
}

describe("the front surface's picture", () => {
  it("has a picture even when the browser in charge can't take one", async () => {
    const { d } = driver([slack]);
    const mac = new MacExecutor({ driver: d, frontPid: async () => 100 });
    await mac.start();
    const front = new FrontExecutor({ mac, fallback: new Browser("playwright") });
    expect(front.capabilities.screenshot).toBe(true);
  });

  it("sends a click on a Chrome tab's picture as fractions the tab turns into its own pixels", async () => {
    const { d } = driver([]);
    const mac = new MacExecutor({ driver: d });
    const chrome = new Browser("chrome");
    chrome.capabilities = { screenshot: true, viewport: false, clickAt: true, read: false };
    const front = new FrontExecutor({ mac, chrome, fallback: new Browser("playwright") });
    await front.screenshot();
    await front.inputClick(0.25, 0.5);
    expect(chrome.executed.at(-1)).toEqual({ kind: "click_at", x: 320, y: 400, fx: 0.25, fy: 0.5 });
    await front.inputText("abc");
    expect(chrome.executed.at(-1)).toMatchObject({ kind: "type", text: "abc", focused: true });
    await front.inputKey("Enter");
    expect(chrome.executed.at(-1)).toEqual({ kind: "press", key: "Enter" });
  });
});

describe("the hub keeps the picture live", () => {
  it("starts streaming once the surface can take a picture, and pushes a frame on every change", async () => {
    const surface = new Browser("playwright");
    let changed: () => void = () => {};
    surface.onChange = (cb: () => void) => {
      changed = cb;
      return () => {};
    };
    const hub = new Hub({ decider: new HeuristicDecider(), screenshotIntervalMs: 20 });
    hub.register(surface);
    const got: ServerMessage[] = [];
    const ws = { readyState: 1, send: (d: string) => got.push(JSON.parse(d) as ServerMessage), on: () => {}, close: () => {} };
    hub.attach(ws as never, surface.id);
    await new Promise((r) => setTimeout(r, 60));
    expect(got.some((m) => m.type === "screenshot")).toBe(false); // can't picture yet
    surface.capabilities = { ...surface.capabilities, screenshot: true };
    await waitFor(async () => got.some((m) => m.type === "screenshot"), 1000);
    const before = got.filter((m) => m.type === "screenshot").length;
    changed();
    await waitFor(async () => got.filter((m) => m.type === "screenshot").length > before, 1000);
    await hub.close();
  });

  it("captures nothing while no panel is looking at the picture, and one fresh frame when one looks again", async () => {
    const surface = new Browser("playwright");
    surface.capabilities = { ...surface.capabilities, screenshot: true };
    let shots = 0;
    const shoot = surface.screenshot.bind(surface);
    surface.screenshot = async () => (shots++, shoot());
    const hub = new Hub({ decider: new HeuristicDecider(), screenshotIntervalMs: 10 });
    hub.register(surface);
    const got: ServerMessage[] = [];
    const ws = { readyState: 1, send: (d: string) => got.push(JSON.parse(d) as ServerMessage), on: () => {}, close: () => {} };
    hub.attach(ws as never, surface.id);
    await waitFor(async () => shots > 0, 1000);
    hub.setFrames(ws as never, false); // the panel was hidden
    await new Promise((r) => setTimeout(r, 30)); // let a capture already under way land
    const resting = shots;
    await new Promise((r) => setTimeout(r, 150));
    expect(shots).toBe(resting);
    const frames = got.filter((m) => m.type === "screenshot").length;
    hub.setFrames(ws as never, true); // shown again: a picture straight away, not on the next change
    await waitFor(async () => got.filter((m) => m.type === "screenshot").length > frames, 1000);
    await hub.close();
  });
});
