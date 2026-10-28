import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Action } from "../core/actions.js";
import type { Executor, ExecutorKind } from "../core/executor.js";
import type { MacWindow } from "../core/mac.js";
import { FrontExecutor } from "../server/executors/front.js";
import { type Driver, MacExecutor, NOT_AVAILABLE, NO_WINDOW } from "../server/executors/mac.js";
import { el } from "./helpers/fake-executor.js";

/** A browser surface with a switchable readiness (the bridge comes and goes). */
class Surface implements Executor {
  readonly capabilities = { screenshot: false, viewport: false, clickAt: true, read: false };
  readonly viewport = { width: 1280, height: 800 };
  url = "https://example.test/";
  executed: Action[] = [];
  constructor(readonly kind: ExecutorKind, public ready: boolean, readonly id = kind) {}
  async start() {}
  async title() { return this.kind; }
  async snapshot() { return { url: this.url, title: this.kind, elements: [el("e0", { text: "Compose" })] }; }
  async screenshot(): Promise<Uint8Array | null> { return null; }
  async execute(action: Action) { this.executed.push(action); return `did ${action.kind}`; }
  async setViewport() { return false; }
  onChange() { return () => {}; }
  async close() {}
}

const slack: MacWindow = { app_name: "Slack", pid: 100, window_id: 15, title: "general - Acme", layer: 0, is_on_screen: true, bounds: { x: 0, y: 0, width: 1200, height: 800 } };
const chrome: MacWindow = { ...slack, app_name: "Google Chrome", pid: 60, window_id: 16, title: "Inbox - Gmail" };

/** A scripted cua-driver: records every call, answers from `answers`, and can be told which
 *  windows are on screen and which snapshot id the next tree carries. */
function fakeDriver(state: { windows: MacWindow[]; snapshotId?: string; stale?: boolean; down?: boolean; accessibility?: boolean; backgroundKeys?: "ok" | "candidates" | "refuse" }) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const driver: Driver = async (tool, args = {}) => {
    calls.push({ tool, args });
    if (state.down) throw new Error("Cua Driver daemon is not running. Start it first with: cua-driver serve");
    switch (tool) {
      case "check_permissions":
        return { accessibility: state.accessibility ?? true, screen_recording: true };
      case "list_windows":
        return { windows: state.windows };
      case "get_window_state":
        // a screenshot-only call: the driver reports the picture's size (its click space)
        if (args.include_accessibility_tree === false) return { screenshot_width: 600, window_bounds: { x: 0, y: 0, width: 1200, height: 800 } };
        return {
          snapshot_id: state.snapshotId ?? "s00000001",
          window_title: "general - Acme",
          elements: [
            { element_index: 3, role: "AXRow", label: "general", actions: ["AXPress"], element_token: `${state.snapshotId ?? "s00000001"}:3` },
            { element_index: 6, role: "AXTextArea", label: "Message #general", element_token: `${state.snapshotId ?? "s00000001"}:6` },
            { element_index: 9, role: "AXStaticText", value: "Abdul", frame: { x: 190, y: 162, w: 40, h: 18 } },
          ],
        };
      case "press_key":
      case "scroll":
        if (args.delivery_mode === "background" && state.backgroundKeys === "candidates") return { candidates: [{ pid: 100 }] };
        if (args.delivery_mode === "background" && state.backgroundKeys === "refuse") throw new Error("background delivery unavailable for this window");
        return { ok: true };
      case "launch_app":
        return { pid: 300, name: args.name, windows: [] };
      case "click":
      case "type_text":
        if (state.stale) throw new Error(`element_token ${args.element_token} is stale: superseded by a newer snapshot`);
        return { ok: true, effect: "unverifiable" };
      default:
        return { ok: true };
    }
  };
  return { driver, calls };
}

describe("MacExecutor over cua-driver", () => {
  it("snapshots the app in front (skipping our own windows) and addresses elements by token", async () => {
    let now = 1000;
    const { driver, calls } = fakeDriver({ windows: [{ ...slack, app_name: "Jev", pid: 7, window_id: 1 }, slack] });
    const mac = new MacExecutor({ driver, ownPids: () => [7], now: () => now });
    await mac.start();
    expect(mac.ready).toBe(true);
    const snap = await mac.snapshot();
    expect(snap.url).toBe("app://Slack");
    expect(snap.title).toBe("general - Acme");
    expect(snap.elements.map((e) => e.id)).toEqual(["e0", "e1"]);
    const walk = calls.find((c) => c.tool === "get_window_state")!;
    expect(walk.args).toMatchObject({ pid: 100, window_id: 15, include_screenshot: false, max_elements: 600 });

    expect(await mac.execute({ kind: "click", elementId: "e0", label: "general" })).toBe("Clicked general");
    expect(calls.at(-1)).toEqual({ tool: "click", args: { pid: 100, element_token: "s00000001:3", action: "press" } });

    // the tree is stale after an action: the next snapshot walks again even inside the TTL
    now += 100;
    await mac.snapshot();
    expect(calls.filter((c) => c.tool === "get_window_state")).toHaveLength(2);
    // and within the TTL with nothing done, it is reused
    now += 100;
    await mac.snapshot();
    expect(calls.filter((c) => c.tool === "get_window_state")).toHaveLength(2);
  });

  it("types into the chosen field, presses Enter to submit, and maps spoken keys", async () => {
    const { driver, calls } = fakeDriver({ windows: [slack] });
    const mac = new MacExecutor({ driver });
    await mac.snapshot();
    expect(await mac.execute({ kind: "type", elementId: "e1", label: "Message #general", text: "hello", submit: true })).toBe('Typed "hello" into Message #general and pressed Enter');
    // keys are delivered to the exact window as real input (background posts to Cocoa text views are dropped)
    const win = { pid: 100, window_id: 15, delivery_mode: "foreground" };
    expect(calls.slice(-2)).toEqual([
      { tool: "type_text", args: { pid: 100, element_token: "s00000001:6", text: "hello" } },
      { tool: "press_key", args: { ...win, key: "return" } },
    ]);
    await mac.snapshot();
    expect(await mac.execute({ kind: "type", elementId: null, label: null, text: "hi", submit: false })).toBe('Typed "hi"');
    // background, not foreground: fronting for the caret write too let a fast queue of typed
    // instructions restore focus to the wrong app between one and the next (M5 follow-up)
    expect(calls.at(-1)).toEqual({ tool: "type_text", args: { pid: 100, text: "hi" } });
    expect(await mac.execute({ kind: "press", key: "cmd+enter" })).toBe("Pressed cmd+enter");
    expect(calls.at(-1)).toEqual({ tool: "press_key", args: { ...win, key: "return", modifiers: ["cmd"] } });
    expect(await mac.execute({ kind: "scroll", direction: "down" })).toBe("Scrolled down");
    expect(calls.at(-1)).toMatchObject({ tool: "scroll", args: { ...win, direction: "down" } });
  });

  it("reports a superseded token the way every surface does, so the loop re-snapshots", async () => {
    const state = { windows: [slack], stale: false };
    const { driver } = fakeDriver(state);
    const mac = new MacExecutor({ driver });
    await mac.snapshot();
    state.stale = true;
    await expect(mac.execute({ kind: "click", elementId: "e0", label: "general" })).rejects.toThrow("general is no longer on the page");
    await expect(mac.execute({ kind: "click", elementId: "e9", label: "nothing" })).rejects.toThrow("nothing is no longer on the page");
  });

  it("opens URLs in the default browser instead of pretending to be one", async () => {
    const opened: string[] = [];
    const { driver } = fakeDriver({ windows: [slack] });
    const mac = new MacExecutor({ driver, open: async (u) => void opened.push(u) });
    expect(await mac.execute({ kind: "navigate", url: "https://mail.google.com" })).toBe("Opened https://mail.google.com in your browser");
    expect(opened).toEqual(["https://mail.google.com"]);
  });

  it("is not ready without the daemon or its grants, launches it once, and says so on actions", async () => {
    const state = { windows: [slack], down: true };
    let launched = 0;
    const { driver } = fakeDriver(state);
    const mac = new MacExecutor({
      driver,
      launchDaemon: async () => {
        launched++;
        state.down = false;
      },
    });
    await mac.start();
    expect(launched).toBe(1);
    expect(mac.ready).toBe(true);
    state.down = true;
    await expect(mac.snapshot()).rejects.toThrow(NOT_AVAILABLE);
    expect(mac.ready).toBe(false);

    const noGrant = new MacExecutor({ driver: fakeDriver({ windows: [], accessibility: false }).driver });
    await noGrant.start();
    expect(noGrant.ready).toBe(false);
  });

  it("has nothing to act on when no ordinary window is in front", async () => {
    const { driver } = fakeDriver({ windows: [] });
    const mac = new MacExecutor({ driver });
    expect(await mac.snapshot()).toEqual({ url: "app://", title: "", elements: [] });
    await expect(mac.execute({ kind: "press", key: "enter" })).rejects.toThrow(NO_WINDOW);
  });
});

describe("FrontExecutor: whatever is in front", () => {
  function setup(windows: MacWindow[], bridgeReady: boolean, macReady = true) {
    const state = { windows, down: !macReady };
    const { driver } = fakeDriver(state);
    const mac = new MacExecutor({ driver });
    const bridge = new Surface("chrome", bridgeReady);
    const fallback = new Surface("playwright", true);
    const front = new FrontExecutor({ mac, chrome: bridge, fallback });
    return { state, mac, bridge, fallback, front };
  }

  it("uses the Mac tree when a native app is in front, and the Chrome bridge when Chrome is", async () => {
    const { state, front, mac, bridge } = setup([slack], true);
    await front.start();
    expect((await front.snapshot()).url).toBe("app://Slack");
    expect(front.kind).toBe("mac");
    expect(front.surface).toBe(mac);
    state.windows = [chrome];
    await front.snapshot();
    expect(front.surface).toBe(bridge);
    expect(front.kind).toBe("chrome");
    await front.execute({ kind: "click", elementId: "e0", label: "Compose" });
    expect(bridge.executed.map((a) => a.kind)).toEqual(["click"]);
  });

  it("falls back to the built-in browser when Chrome is in front but the bridge is not connected, and when the driver is down", async () => {
    const a = setup([chrome], false);
    await a.front.start();
    await a.front.snapshot();
    expect(a.front.surface).toBe(a.fallback);
    const b = setup([slack], true, false);
    await b.front.start();
    await b.front.snapshot();
    expect(b.front.surface).toBe(b.bridge);
    const c = setup([], true);
    await c.front.start();
    await c.front.snapshot();
    expect(c.front.surface).toBe(c.bridge); // nothing native in front: the browser it is
  });

  it("tells listeners when the surface behind it changes", async () => {
    const { state, front } = setup([slack], true);
    let changes = 0;
    front.onChange(() => changes++);
    await front.start();
    await front.snapshot();
    const after = changes;
    state.windows = [chrome];
    await front.snapshot();
    expect(changes).toBeGreaterThan(after);
  });
});

describe("MacExecutor for the brain: named apps, in the background", () => {
  const notes: MacWindow = { ...slack, app_name: "Notes", pid: 200, window_id: 21, title: "Groceries" };

  it("reads the named app, not the one in front, with its text and without the menu bar", async () => {
    const { driver, calls } = fakeDriver({ windows: [notes, slack] });
    const mac = new MacExecutor({ driver, frontPid: async () => 200 });
    const r = await mac.readApp("Slack");
    expect(r.app).toBe("Slack");
    expect(calls.find((c) => c.tool === "get_window_state")!.args).toMatchObject({ pid: 100, window_id: 15 });
    await expect(mac.readApp("Mail")).rejects.toThrow(/Mail isn't open/);
  });

  it("clicks a line of text with no id at its own centre, in the driver's click space, in the background", async () => {
    // Slack's DM rows are static text in a list: nothing to press, so the click goes to the text's
    // frame — scaled into the window screenshot's pixels, which is what the driver clicks in.
    const { driver, calls } = fakeDriver({ windows: [slack] });
    const mac = new MacExecutor({ driver });
    await mac.readApp("Slack");
    expect(await mac.clickText("abdul")).toBe('Clicked "Abdul"');
    const click = calls.find((c) => c.tool === "click")!.args;
    // centre (210, 171) in points × 600/1200
    expect(click).toMatchObject({ pid: 100, window_id: 15, x: 105, y: 86, delivery_mode: "background" });
    expect(click.element_token).toBeUndefined();
    await expect(mac.clickText("Prachi")).rejects.toThrow(/No text "Prachi" in the last read/);
  });

  it("presses keys in the background, and only brings the window forward when the driver will not deliver there — and says so", async () => {
    for (const mode of ["ok", "candidates", "refuse"] as const) {
      const { driver, calls } = fakeDriver({ windows: [slack], backgroundKeys: mode });
      const mac = new MacExecutor({ driver });
      await mac.readApp("Slack");
      const said = await mac.actInApp({ kind: "press", key: "enter" });
      const keys = calls.filter((c) => c.tool === "press_key").map((c) => c.args.delivery_mode);
      if (mode === "ok") {
        expect(keys).toEqual(["background"]);
        expect(said).toBe("Pressed enter");
      } else {
        expect(keys, mode).toEqual(["background", "foreground"]);
        expect(said, mode).toMatch(/bring Slack forward/);
      }
    }
  });

  it("leaves the fast lane's delivery alone: the window the user is looking at gets real input", async () => {
    const { driver, calls } = fakeDriver({ windows: [slack] });
    const mac = new MacExecutor({ driver });
    await mac.snapshot();
    await mac.execute({ kind: "press", key: "enter" });
    expect(calls.filter((c) => c.tool === "press_key").map((c) => c.args.delivery_mode)).toEqual(["foreground"]);
  });

  it("chooses menus by path, sets values by token, opens apps without fronting them, and saves a screenshot of the window", async () => {
    const { driver, calls } = fakeDriver({ windows: [slack] });
    const mac = new MacExecutor({ driver });
    await mac.readApp("Slack");
    await mac.menu(["File", "New Message"]);
    expect(calls.at(-1)).toEqual({ tool: "invoke_menu", args: { pid: 100, window_id: 15, path: ["File", "New Message"] } });
    await mac.readApp("Slack");
    await mac.setValue("e1", "Message", "hi");
    expect(calls.at(-1)).toEqual({ tool: "set_value", args: { pid: 100, window_id: 15, element_token: "s00000001:6", value: "hi" } });
    expect(await mac.launch("Notes")).toMatch(/in the background/);
    expect(calls.at(-1)).toEqual({ tool: "launch_app", args: { name: "Notes" } });
    await mac.readApp("Slack");
    const shot = path.join(mkdtempSync(path.join(tmpdir(), "jev-shot-")), "run1", "01-click.png");
    await mac.captureTo(shot);
    expect(calls.at(-1)).toEqual({ tool: "get_window_state", args: { pid: 100, window_id: 15, include_accessibility_tree: false, max_dimension: 1280, screenshot_out_file: shot } });
  });
});

describe("\"Your screen\" pictures the user's window, live (v11.5)", () => {
  const jev: MacWindow = { ...slack, app_name: "Jev", pid: 7, window_id: 1, title: "Jev" };
  it("uses the explicit pictured window and foreground delivery for a remote human", async () => {
    const { driver, calls } = fakeDriver({ windows: [chrome, slack] });
    const mac = new MacExecutor({ driver, manualDelivery: "foreground", pictureWindow: () => slack });
    await mac.start(); await mac.screenshot(); expect((await mac.frameInfo()).title).toBe(slack.title);
    await mac.inputClick(.5, .5); expect(calls.at(-1)?.args).toMatchObject({ pid: slack.pid, window_id: slack.window_id, delivery_mode: "foreground" });
    await mac.inputText("synthetic input"); expect(calls.at(-1)).toMatchObject({ tool: "type_text", args: { pid: slack.pid, window_id: slack.window_id, delivery_mode: "foreground", text: "synthetic input" } });
    await mac.inputKey("cmd+a"); expect(calls.at(-1)).toMatchObject({ tool: "press_key", args: { key: "a", modifiers: ["cmd"], delivery_mode: "foreground" } });
  });
  it("uses different capture files for concurrent desktop and phone executors", async () => {
    const { driver, calls } = fakeDriver({ windows: [slack] });
    const a = new MacExecutor({ driver, pictureWindow: () => slack }), b = new MacExecutor({ driver, pictureWindow: () => slack });
    await Promise.all([a.screenshot(), b.screenshot()]);
    const files = calls.filter((c) => c.tool === "get_window_state" && c.args.screenshot_out_file).map((c) => c.args.screenshot_out_file);
    expect(files).toHaveLength(2); expect(new Set(files).size).toBe(2);
  });

  it("pictures the app Jev read while she works there, and his front window again once she moves on", async () => {
    const state = { windows: [chrome, slack] };
    const { driver } = fakeDriver(state);
    const mac = new MacExecutor({ driver, ownPids: () => [7], screenshotMinIntervalMs: 0 });
    await mac.start();
    await mac.readApp("Slack");
    await mac.screenshot();
    expect((await mac.frameInfo()).title).toBe("general - Acme"); // Slack, behind Chrome
    mac.release(); // the brain moved on to Chrome
    await mac.screenshot();
    expect((await mac.frameInfo()).url).toBe("app://Google Chrome");
  });

  it("never falls back to an old window: nothing in front shows as not live, with the reason", async () => {
    // Live 2026-09-28: the pane sat on a Finder window read long before, because "nothing in front"
    // fell back to the last held window with no time limit.
    const state = { windows: [slack] };
    const { driver } = fakeDriver(state);
    const mac = new MacExecutor({ driver, ownPids: () => [7], screenshotMinIntervalMs: 0 });
    await mac.start();
    await mac.readApp("Slack");
    mac.release();
    state.windows = [jev];
    expect(await mac.screenshot()).toBeNull();
    expect(mac.frameProblem).toBe("Nothing in front but Jev's own windows");
  });

  it("follows Chrome coming to the front without any fast-lane command, through the bridge", async () => {
    const state = { windows: [slack] };
    const { driver } = fakeDriver(state);
    const mac = new MacExecutor({ driver, screenshotMinIntervalMs: 0 });
    let chromeShots = 0;
    const bridge = new (class extends Surface {
      override readonly capabilities = { screenshot: true, viewport: false, clickAt: true, read: false };
      override async screenshot() {
        chromeShots++;
        return new Uint8Array([1, 2, 3]);
      }
    })("chrome", true);
    const front = new FrontExecutor({ mac, chrome: bridge, fallback: new Surface("playwright", true) });
    await front.start();
    await front.screenshot();
    expect(chromeShots).toBe(0); // Slack in front: the Mac pictures it
    state.windows = [chrome];
    await new Promise((r) => setTimeout(r, 1050)); // the front window is looked up at most once a second
    expect(await front.screenshot()).toEqual(new Uint8Array([1, 2, 3]));
    expect(chromeShots).toBe(1);
  });
});
