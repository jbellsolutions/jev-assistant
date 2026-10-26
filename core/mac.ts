/** The Mac as a surface: which window is "in front" for the user, and how an accessibility
 *  tree becomes the same PageSnapshot the decision loop reads for web pages. Pure functions
 *  over the shapes cua-driver returns; the driver itself is called from server/executors/mac.ts. */
import { MAX_ELEMENTS, type PageElement, type PageSnapshot } from "./elements.js";

/** One top-level window as `list_windows` reports it. */
export interface MacWindow {
  app_name: string;
  pid: number;
  window_id: number;
  title: string;
  layer: number;
  is_on_screen: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

/** One row of `get_window_state.elements`. */
export interface AxElement {
  element_index: number;
  element_token?: string;
  role: string;
  label?: string;
  value?: string;
  actions?: string[];
  frame?: { x: number; y: number; w: number; h: number };
  depth?: number;
}

/** Processes whose windows are never "the app the user is in": system chrome, our own
 *  overlay, permission prompts. Matched on `app_name` as WindowServer reports it. */
export const IGNORED_APPS = new Set([
  "Cua Driver",
  "CuaDriver",
  "universalAccessAuthWarn",
  "Window Server",
  "WindowServer",
  "Dock",
  "Control Center",
  "Notification Center",
  "NotificationCenter",
  "Spotlight",
  "CursorUIViewService",
  "Screenshot",
  "loginwindow",
]);

/** Windows smaller than this are tooltips, badges and palettes, not something to act in. */
const MIN_WINDOW = { width: 200, height: 120 };

/** The window the user is looking at. `frontPid` is the frontmost application (from `lsappinfo
 *  front`): the app the keyboard and menu bar belong to, which is not the same as the topmost
 *  window in raw z-order (a document window can float above the active app). When it names an
 *  ordinary app, we take that app's largest on-screen window; otherwise we fall back to the
 *  first ordinary on-screen window in z-order. `ownPids` is our own process (the floating panel). */
export function frontWindow(windows: MacWindow[], ownPids: number[] = [], frontPid?: number | null): MacWindow | null {
  const own = new Set(ownPids);
  const usable = (w: MacWindow) => w.layer === 0 && w.is_on_screen && !own.has(w.pid) && !IGNORED_APPS.has(w.app_name) && w.bounds.width >= MIN_WINDOW.width && w.bounds.height >= MIN_WINDOW.height;
  if (frontPid && !own.has(frontPid)) {
    const mine = windows.filter((w) => w.pid === frontPid && usable(w));
    if (mine.length) return mine.sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0]!;
  }
  return windows.find(usable) ?? null;
}

/** An app's own window, by the name the user says ("Slack", "slack", "Slack.app"), for work in the
 *  background: the app does not have to be in front, or even on screen. Exact names win over
 *  partial ones; on-screen windows over hidden ones; then the biggest (the main window, not a
 *  palette or the menu-bar strips an Electron app also reports). */
export function appWindow(windows: MacWindow[], name: string, ownPids: number[] = []): MacWindow | null {
  const want = name.trim().toLowerCase().replace(/\.app$/, "");
  if (!want) return null;
  const own = new Set(ownPids);
  const usable = windows.filter((w) => w.layer === 0 && !own.has(w.pid) && !IGNORED_APPS.has(w.app_name) && w.bounds.width >= MIN_WINDOW.width && w.bounds.height >= MIN_WINDOW.height);
  const exact = usable.filter((w) => w.app_name.toLowerCase() === want);
  const pool = exact.length ? exact : usable.filter((w) => w.app_name.toLowerCase().includes(want));
  const area = (w: MacWindow) => w.bounds.width * w.bounds.height;
  return pool.sort((a, b) => Number(b.is_on_screen) - Number(a.is_on_screen) || area(b) - area(a))[0] ?? null;
}

export const BROWSER_APPS = new Set(["Google Chrome", "Google Chrome Beta", "Google Chrome Canary", "Chromium"]);

/** "app://Google Chrome" — the Mac counterpart of a page URL. */
export function appUrl(appName: string): string {
  return `app://${appName}`;
}

const ROLE_NAMES: Record<string, string> = {
  AXButton: "button",
  AXPopUpButton: "dropdown",
  AXMenuButton: "menu button",
  AXMenuItem: "menu item",
  AXMenuBarItem: "menu",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio button",
  AXTabGroup: "tabs",
  AXTab: "tab",
  AXRow: "row",
  AXCell: "cell",
  AXLink: "link",
  AXTextField: "text field",
  AXSecureTextField: "password field",
  AXTextArea: "text area",
  AXComboBox: "combo box",
  AXSearchField: "search field",
  AXSlider: "slider",
  AXIncrementor: "stepper",
  AXDisclosureTriangle: "expander",
  AXImage: "image",
  AXStaticText: "text",
  AXOutline: "list",
  AXList: "list",
  AXTable: "table",
  AXToolbar: "toolbar",
  AXWindow: "window",
  AXWebArea: "web content",
  AXGroup: "group",
  AXSplitter: "splitter",
  AXScrollArea: "scroll area",
};

const TEXT_ROLES = new Set(["AXTextField", "AXSecureTextField", "AXTextArea", "AXComboBox", "AXSearchField"]);
const PRESSABLE = new Set(["AXPress", "AXConfirm", "AXPick", "AXOpen"]);
/** Containers that expose AXPress/AXShowMenu without being something one would "click". */
const CONTAINER_ROLES = new Set(["AXWindow", "AXWebArea", "AXGroup", "AXScrollArea", "AXSplitter", "AXToolbar", "AXOutline", "AXList", "AXTable", "AXTabGroup", "AXSplitGroup", "AXLayoutArea"]);

/** Is this something the user could click into or type into? Static text is kept only when
 *  it is pressable (a row's label in some apps), never as decoration. */
export function isInteractive(e: AxElement): boolean {
  if (CONTAINER_ROLES.has(e.role)) return false;
  if (TEXT_ROLES.has(e.role)) return true;
  const actions = e.actions ?? [];
  if (actions.some((a) => PRESSABLE.has(a))) return true;
  return e.role === "AXMenuItem" || e.role === "AXTab" || e.role === "AXLink";
}

export function roleName(role: string): string {
  return ROLE_NAMES[role] ?? role.replace(/^AX/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/** The app's menu bar and its menus. The brain reaches them by path (`invoke_menu`) instead of by
 *  element: in a real app they are most of the tree (117 of Slack's 362 rows), and listing them
 *  crowded out everything that was actually on screen. */
const MENU_ROLES = new Set(["AXMenuBar", "AXMenuBarItem", "AXMenu", "AXMenuItem"]);

export function isMenuRow(e: AxElement): boolean {
  return MENU_ROLES.has(e.role);
}

/** The top-level menus (File, Edit, View…), in order — named so the brain can build a path. */
export function menuBar(elements: AxElement[]): string[] {
  const names = elements.filter((e) => e.role === "AXMenuBarItem").map((e) => (e.label ?? "").trim()).filter((n) => n && n !== "Apple");
  return [...new Set(names)];
}

/** What the window SAYS, not just what can be clicked: the static text in tree order, pieces on the
 *  same line joined. This is the part v11's read left out — Slack's messages are static text, so the
 *  brain clicked Activity, DMs and Mentions over and over looking for words it was never shown. */
export function macText(elements: AxElement[], max = 6_000): string {
  const lines: string[] = [];
  let line = "";
  let y: number | null = null;
  for (const e of elements) {
    if (e.role !== "AXStaticText" && e.role !== "AXHeading") continue;
    const t = (e.value || e.label || "").replace(/\s+/g, " ").trim();
    if (!t || /^[…()\-·|,.:;]$/.test(t)) continue;
    const ey = e.frame?.y ?? null;
    if (line && ey !== null && y !== null && Math.abs(ey - y) < 6) line += ` ${t}`;
    else {
      if (line) lines.push(line);
      line = t;
    }
    y = ey;
  }
  if (line) lines.push(line);
  const out = lines.filter((l, i) => l !== lines[i - 1]).join("\n");
  return out.length > max ? `${out.slice(0, max)}\n… (${out.length - max} more characters)` : out;
}

/** Interactive AX elements as PageElements, ids `e<i>` in tree order. The map back to the
 *  driver's tokens is returned alongside so execute() can address the exact element.
 *  `skipMenus`: leave out the menu bar (the brain uses menu paths instead). */
export function toPageElements(elements: AxElement[], max = MAX_ELEMENTS, opts: { skipMenus?: boolean } = {}): { elements: PageElement[]; tokens: Map<string, AxElement> } {
  const out: PageElement[] = [];
  const tokens = new Map<string, AxElement>();
  for (const e of elements) {
    if (!isInteractive(e)) continue;
    if (opts.skipMenus && isMenuRow(e)) continue;
    const label = (e.label ?? "").trim();
    const value = (e.value ?? "").trim();
    if (!label && !value && !TEXT_ROLES.has(e.role)) continue;
    const id = `e${out.length}`;
    const isText = TEXT_ROLES.has(e.role);
    // a text view with no title reports its contents as its label: that is not a name
    const fieldName = isText && label && label !== value && label.length <= 60 && !label.includes("\n") ? label : "";
    out.push({
      id,
      tag: "ax",
      role: roleName(e.role),
      type: e.role,
      text: isText ? "" : label,
      label: fieldName,
      placeholder: isText ? value.split("\n")[0]!.slice(0, 60) : "",
      name: "",
      hrefShort: null,
      inViewport: !e.frame || (e.frame.w > 1 && e.frame.h > 1),
    });
    tokens.set(id, e);
    if (out.length >= max) break;
  }
  return { elements: out, tokens };
}

export function macSnapshot(win: MacWindow, elements: AxElement[], max = MAX_ELEMENTS, opts: { skipMenus?: boolean } = {}): { snapshot: PageSnapshot; tokens: Map<string, AxElement> } {
  const { elements: els, tokens } = toPageElements(elements, max, opts);
  return { snapshot: { url: appUrl(win.app_name), title: win.title || win.app_name, elements: els }, tokens };
}

/** Key names as the decision loop says them -> cua-driver's `press_key` names. */
export function driverKey(key: string): { key: string; modifiers: string[] } {
  const parts = key.toLowerCase().split(/[+\s-]+/).filter(Boolean);
  const modifiers: string[] = [];
  let main = "return";
  for (const p of parts) {
    if (p === "cmd" || p === "command" || p === "meta") modifiers.push("cmd");
    else if (p === "shift") modifiers.push("shift");
    else if (p === "alt" || p === "option" || p === "opt") modifiers.push("option");
    else if (p === "ctrl" || p === "control") modifiers.push("ctrl");
    else main = p;
  }
  const names: Record<string, string> = { enter: "return", esc: "escape", backspace: "delete", del: "delete", pgup: "pageup", pgdn: "pagedown", arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right" };
  return { key: names[main] ?? main, modifiers };
}

/** cua-driver refuses an element token once a newer snapshot exists; the Executor contract
 *  wants that reported as the element having left the page. */
export function isStaleTokenError(message: string): boolean {
  return /stale|superseded|snapshot.*(replaced|expired|not found|unknown)|element_token/i.test(message);
}

/** The on-screen text the brain named, among a read's static text: an exact match first, then one
 *  that starts with it, then one that contains it. Only text with a frame can be clicked. Null when
 *  nothing matches — the brain is told so rather than a near miss being clicked. */
export function findText(elements: AxElement[], text: string): AxElement | null {
  const want = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (want.length < 2) return null;
  const rows = elements.filter((e) => (e.role === "AXStaticText" || e.role === "AXHeading") && e.frame && e.frame.w > 0 && e.frame.h > 0);
  const said = (e: AxElement) => (e.value || e.label || "").replace(/\s+/g, " ").trim().toLowerCase();
  return rows.find((e) => said(e) === want) ?? rows.find((e) => said(e).startsWith(want)) ?? rows.find((e) => said(e).includes(want)) ?? null;
}

/** The centre of an element's frame (screen points) in the driver's click space: pixels of the
 *  window screenshot, whose width the driver reports. Verified live on Slack 2026-09-25: a 2560pt
 *  window screenshots at 1567px, so points are scaled by 1567/2560, from the window's top-left. */
/** A click the user made on the panel's picture of a window, as a fraction of that picture, in the
 *  driver's click space (its own screenshot of the window: `screenshotWidth` wide, the window's
 *  aspect). Clamped, so a click on the very edge still lands inside. */
export function pointFor(fx: number, fy: number, bounds: { width: number; height: number }, screenshotWidth: number): { x: number; y: number } {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const height = (bounds.height * screenshotWidth) / bounds.width;
  return { x: Math.round(clamp(fx) * (screenshotWidth - 1)), y: Math.round(clamp(fy) * (height - 1)) };
}

export function pixelFor(frame: { x: number; y: number; w: number; h: number }, bounds: { x: number; y: number; width: number }, screenshotWidth: number): { x: number; y: number } {
  const scale = screenshotWidth / bounds.width;
  return { x: Math.round((frame.x + frame.w / 2 - bounds.x) * scale), y: Math.round((frame.y + frame.h / 2 - bounds.y) * scale) };
}
