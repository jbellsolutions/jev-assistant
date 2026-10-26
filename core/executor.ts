import type { Action } from "./actions.js";
import type { PageSnapshot, PageText } from "./elements.js";

/** What an executor can do beyond the Action union; the hub and UIs adapt to these. */
export interface ExecutorCapabilities {
  /** Can produce JPEG frames for a live view. */
  screenshot: boolean;
  /** Honours setViewport (a real browser tab or desktop app cannot be resized by us). */
  viewport: boolean;
  /** Supports the click_at action. */
  clickAt: boolean;
  /** Implements read(): the surface can hand back the page's prose, not just its buttons. */
  read: boolean;
}

export type ExecutorKind = "playwright" | "chrome" | "mac" | "orgo";

/** One controllable surface: a Playwright browser, the user's Chrome tab via the bridge, the
 *  Mac's frontmost app via accessibility, ... Every surface exposes the same three verbs the
 *  decision loop needs — snapshot what's there, execute an Action, tell me when it changed —
 *  so decide.ts and the session loop never know which one they are driving.
 *
 *  Contract shared by all implementations: execute() on a click/type whose element id is no
 *  longer present must throw `${label} is no longer on the page`. */
export interface Executor {
  readonly id: string;
  readonly kind: ExecutorKind;
  readonly capabilities: ExecutorCapabilities;
  readonly viewport: { width: number; height: number };
  /** Current location: a URL for browsers, app://<bundle id> for desktop apps. */
  readonly url: string;
  /** False while the surface cannot be driven (a bridge that is not connected); absent = ready. */
  readonly ready?: boolean;
  start(): Promise<void>;
  title(): Promise<string>;
  snapshot(): Promise<PageSnapshot>;
  /** The page's readable text. Present only when `capabilities.read` is true — a snapshot
   *  lists what you can click, this is what you can actually learn from the page. */
  read?(max?: number): Promise<PageText>;
  /** Why `capabilities.read` is false, when the surface knows something the caller can act on
   *  (an out-of-date bridge). Callers show this instead of a generic "cannot read" line. */
  readonly readHint?: string | null;
  /** The Chrome bridge's protocol, from its hello (0 before one). Only the bridge has one. */
  readonly protocol?: number;
  /** JPEG bytes, or null when a frame cannot be produced right now. */
  screenshot(): Promise<Uint8Array | null>;
  /** Perform an action and return a short status line for the UI. */
  execute(action: Action): Promise<string>;
  /** Resize the surface; returns false when nothing changed (or the surface can't resize). */
  setViewport(width: number, height: number): Promise<boolean>;
  /** Called whenever the surface changed on its own (navigation, load, tab switch). */
  onChange(cb: () => void): () => void;
  close(): Promise<void>;
  /** What the last screenshot shows, when that is not simply `url`/`title()` — a surface that
   *  pictures one window while acting in another. */
  frameInfo?(): Promise<{ url: string; title: string }>;
  /** Why the last screenshot() came back empty, in words for the panel ("only Jev's windows are in
   *  front"). Null when the last picture worked. */
  readonly frameProblem?: string | null;
  /** the user's own hands on the panel's picture: a click at a fraction of the frame, typed text, a
   *  key. No decision and no approval — it is him. Absent when the surface can't take input. */
  inputClick?(fx: number, fy: number): Promise<string>;
  inputText?(text: string): Promise<string>;
  inputKey?(key: string): Promise<string>;
}
