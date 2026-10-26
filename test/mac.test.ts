import { describe, expect, it } from "vitest";
import { type AxElement, type MacWindow, appWindow, driverKey, findText, frontWindow, isStaleTokenError, macSnapshot, macText, menuBar, pixelFor, toPageElements } from "../core/mac.js";

const win = (o: Partial<MacWindow>): MacWindow => ({
  app_name: "Slack",
  pid: 100,
  window_id: 1,
  title: "general - Acme",
  layer: 0,
  is_on_screen: true,
  bounds: { x: 0, y: 0, width: 1200, height: 800 },
  ...o,
});

describe("mac: the window in front", () => {
  it("is the first ordinary on-screen window that is not ours, not system UI and not a tooltip", () => {
    const list = [
      win({ app_name: "Jev", pid: 7, window_id: 10 }), // the floating panel, just focused
      win({ app_name: "universalAccessAuthWarn", pid: 8, window_id: 11, title: "Screen Recording" }),
      win({ app_name: "Cua Driver", pid: 9, window_id: 12, bounds: { x: 0, y: 0, width: 2560, height: 1440 } }),
      win({ app_name: "Slack", pid: 100, window_id: 13, bounds: { x: 0, y: 0, width: 54, height: 54 } }), // a badge
      win({ app_name: "Finder", pid: 50, window_id: 14, is_on_screen: false }),
      win({ app_name: "Slack", pid: 100, window_id: 15 }),
      win({ app_name: "Google Chrome", pid: 60, window_id: 16 }),
    ];
    expect(frontWindow(list, [7])?.window_id).toBe(15);
    expect(frontWindow(list)?.window_id).toBe(10); // without ownPids the panel counts
    expect(frontWindow([win({ layer: 3 })])).toBeNull();
    expect(frontWindow([])).toBeNull();
  });

  it("prefers the frontmost app's largest window over raw z-order (a doc window can float above the active app)", () => {
    const list = [
      win({ app_name: "TextEdit", pid: 30, window_id: 20, bounds: { x: 0, y: 0, width: 656, height: 400 } }), // topmost in z-order
      win({ app_name: "Slack", pid: 100, window_id: 21, bounds: { x: 0, y: 0, width: 100, height: 300 } }), // a thread pane
      win({ app_name: "Slack", pid: 100, window_id: 22, bounds: { x: 0, y: 0, width: 2308, height: 1341 } }), // the main window, further back
    ];
    expect(frontWindow(list, [], 100)?.window_id).toBe(22); // Slack is frontmost app → its biggest window
    expect(frontWindow(list, [], 30)?.window_id).toBe(20); // TextEdit frontmost → its window
    expect(frontWindow(list, [], 999)?.window_id).toBe(20); // frontmost app has no ordinary window → z-order
    expect(frontWindow(list, [30], 30)?.window_id).toBe(22); // our own pid is never the front; the thread pane is too small
  });
});

describe("mac: accessibility tree -> page elements", () => {
  const tree: AxElement[] = [
    { element_index: 0, role: "AXWindow", label: "general - Acme", actions: ["AXRaise"], element_token: "s1:0" },
    { element_index: 1, role: "AXWebArea", label: "general - Acme", actions: ["AXShowMenu", "AXScrollToVisible"], element_token: "s1:1" },
    { element_index: 2, role: "AXStaticText", label: "Channels", actions: ["AXShowMenu"], element_token: "s1:2" },
    { element_index: 3, role: "AXRow", label: "general", actions: ["AXPress", "AXShowMenu"], element_token: "s1:3", frame: { x: 10, y: 100, w: 200, h: 24 } },
    { element_index: 4, role: "AXRow", label: "random", actions: ["AXPress"], element_token: "s1:4", frame: { x: 10, y: 124, w: 200, h: 1 } },
    { element_index: 5, role: "AXButton", label: "New message", actions: ["AXPress"], element_token: "s1:5" },
    { element_index: 6, role: "AXTextArea", label: "Message #general", value: "", element_token: "s1:6" },
    { element_index: 7, role: "AXButton", label: "", actions: ["AXPress"], element_token: "s1:7" }, // unlabeled: useless to pick from
    { element_index: 8, role: "AXLink", label: "Acme docs", element_token: "s1:8" },
    { element_index: 9, role: "AXTextArea", label: "hello from jev\nsecond line", value: "hello from jev\nsecond line", element_token: "s1:9" },
  ];

  it("keeps clickable and typable things with a name, in tree order, ids e0.., and remembers their tokens", () => {
    const { elements, tokens } = toPageElements(tree);
    expect(elements.map((e) => [e.id, e.role, e.text || e.label])).toEqual([
      ["e0", "row", "general"],
      ["e1", "row", "random"],
      ["e2", "button", "New message"],
      ["e3", "text area", "Message #general"],
      ["e4", "link", "Acme docs"],
      ["e5", "text area", ""], // an untitled text view is not named after its contents
    ]);
    expect(elements[5]!.placeholder).toBe("hello from jev");
    expect(tokens.get("e0")?.element_token).toBe("s1:3");
    expect(tokens.get("e3")?.element_token).toBe("s1:6");
    expect(elements[1]!.inViewport).toBe(false); // an h:1 frame is a virtualised row off screen
    expect(elements[0]!.inViewport).toBe(true);
  });

  it("caps the list and labels the snapshot after the app", () => {
    const { snapshot, tokens } = macSnapshot(win({ title: "" }), tree, 2);
    expect(snapshot).toEqual({ url: "app://Slack", title: "Slack", elements: [expect.objectContaining({ id: "e0" }), expect.objectContaining({ id: "e1" })] });
    expect(tokens.size).toBe(2);
  });
});

describe("mac: keys and errors", () => {
  it("translates spoken key names to the driver's", () => {
    expect(driverKey("Enter")).toEqual({ key: "return", modifiers: [] });
    expect(driverKey("esc")).toEqual({ key: "escape", modifiers: [] });
    expect(driverKey("cmd+enter")).toEqual({ key: "return", modifiers: ["cmd"] });
    expect(driverKey("shift tab")).toEqual({ key: "tab", modifiers: ["shift"] });
    expect(driverKey("Control-Option-Delete")).toEqual({ key: "delete", modifiers: ["ctrl", "option"] });
  });

  it("recognises the driver's stale-snapshot refusals", () => {
    expect(isStaleTokenError("element_token s1:3 is stale: superseded by snapshot s2")).toBe(true);
    expect(isStaleTokenError("snapshot s1 not found")).toBe(true);
    expect(isStaleTokenError("AXPress failed: element not enabled")).toBe(false);
  });
});

describe("mac: an app by name, for work in the background", () => {
  const strip = (o: Partial<MacWindow>) => win({ bounds: { x: 0, y: 0, width: 2560, height: 24 }, is_on_screen: false, ...o });
  it("finds the app's main window even when it is not in front — not its menu-bar strips", () => {
    const windows = [win({ app_name: "Finder", pid: 1, window_id: 1 }), strip({ window_id: 56724 }), win({ window_id: 56726, bounds: { x: 0, y: 26, width: 2560, height: 1359 } }), strip({ window_id: 56725 })];
    expect(appWindow(windows, "slack")?.window_id).toBe(56726);
    expect(appWindow(windows, "Slack.app")?.window_id).toBe(56726);
  });
  it("prefers an exact name over a partial one, on-screen over hidden, and never our own window", () => {
    const windows = [win({ app_name: "Slack Helper", pid: 5, window_id: 9 }), win({ app_name: "Slack", pid: 6, window_id: 2, is_on_screen: false }), win({ app_name: "Slack", pid: 6, window_id: 3, bounds: { x: 0, y: 0, width: 400, height: 300 } })];
    expect(appWindow(windows, "Slack")?.window_id).toBe(3);
    expect(appWindow(windows, "Slack", [6])?.window_id).toBe(9);
    expect(appWindow(windows, "Notes")).toBeNull();
  });
});

describe("mac: what the window says", () => {
  const t = (label: string, y: number, role = "AXStaticText"): AxElement => ({ element_index: y, role, label, value: label, frame: { x: 0, y, w: 50, h: 18 } });
  it("keeps the static text the old read threw away, one line per row, and drops lone punctuation", () => {
    const text = macText([t("Xander", 100), t("Mention in", 120), t("main-convo-", 120), t("…", 140), t("Hi @the user, here are the clips", 160), { element_index: 9, role: "AXButton", label: "Send", actions: ["AXPress"] }]);
    expect(text).toBe("Xander\nMention in main-convo-\nHi @the user, here are the clips");
  });
  it("caps the text and says how much was left out", () => {
    const text = macText([t("x".repeat(50), 1), t("y".repeat(50), 30)], 60);
    expect(text).toMatch(/… \(41 more characters\)$/);
  });
  it("leaves the menu bar out of the brain's elements and names the top-level menus instead", () => {
    const els: AxElement[] = [
      { element_index: 1, role: "AXMenuBarItem", label: "Apple", actions: ["AXPress"] },
      { element_index: 2, role: "AXMenuBarItem", label: "File", actions: ["AXPress"] },
      { element_index: 3, role: "AXMenuItem", label: "New Message", actions: ["AXPress"] },
      { element_index: 4, role: "AXButton", label: "Search", actions: ["AXPress"] },
    ];
    expect(toPageElements(els, 50, { skipMenus: true }).elements.map((e) => e.text)).toEqual(["Search"]);
    expect(toPageElements(els).elements.length).toBe(4); // the fast lane's read is unchanged
    expect(menuBar(els)).toEqual(["File"]);
  });
});

describe("clicking a line of text", () => {
  const rows = [
    { element_index: 1, role: "AXStaticText", value: "Abdul Rahman", frame: { x: 0, y: 0, w: 10, h: 10 } },
    { element_index: 2, role: "AXStaticText", value: "Abdul", frame: { x: 0, y: 20, w: 10, h: 10 } },
    { element_index: 3, role: "AXStaticText", value: "Prachi" },
    { element_index: 4, role: "AXButton", label: "Andrea", frame: { x: 0, y: 40, w: 10, h: 10 } },
  ];

  it("prefers the exact line, then the start of one, and never a line it cannot place", () => {
    expect(findText(rows, "abdul")?.element_index).toBe(2);
    expect(findText(rows, "Abdul R")?.element_index).toBe(1);
    expect(findText(rows, "Prachi")).toBeNull(); // no frame
    expect(findText(rows, "Andrea")).toBeNull(); // a button has an id; text clicks are for text
    expect(findText(rows, "a")).toBeNull();
  });

  it("maps a frame's centre into the window screenshot's pixels", () => {
    // live Slack: 2560pt window, 1567px screenshot, window at y=26
    expect(pixelFor({ x: 190, y: 162, w: 41, h: 18 }, { x: 0, y: 26, width: 2560 }, 1567)).toEqual({ x: 129, y: 89 });
  });
});
