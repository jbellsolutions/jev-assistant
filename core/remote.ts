/** The wire between the companion and a remote surface — today the Chrome bridge extension
 *  driving the user's own browser. The companion asks; the bridge answers with the same
 *  shapes the Playwright executor produces, so the session loop cannot tell them apart.
 *
 *  Socket: the bridge connects to `/ws/bridge?token=…` and says hello; the companion sends
 *  `exec_req`s and `ping`s; the bridge answers each request by id and reports tab changes. */
import type { Action } from "./actions.js";
import type { PageElement, PageText } from "./elements.js";

/** 2 added the `read` op; 3 added `tab` (Jev's own background window). The companion checks the
 *  bridge's hello against this so an out-of-date unpacked extension reports itself instead of
 *  failing on an unknown op — or, worse, ignoring `tab` and acting in the tab the user is looking at. */
/** 4: panel input — `click_at` by fractions of the page, `type` at the caret (`focused`).
 *  5: element snapshots carry a field's current `value`, so the worker can check its own typing. */
export const BRIDGE_PROTOCOL = 5;

/** Which tab an op is for. "current": the tab the user is looking at (the fast lane, "this page").
 *  "jev": a tab in Jev's own minimized window of the same Chrome — same profile, same logins,
 *  never on screen, never focused. The brain works there. */
export type TabTarget = "current" | "jev";

export interface TabInfo {
  url: string;
  title: string;
}

/** Elements as the page script returns them: ids are assigned by position (see extractElements). */
export type RawElement = Omit<PageElement, "id">;

export interface RawSnapshot extends TabInfo {
  elements: RawElement[];
}

/** Page text as the read script returns it; the companion adds url/title. */
export type RawPageText = Omit<PageText, "url" | "title">;

export type RemoteOp = (
  | { op: "snapshot"; max: number }
  | { op: "execute"; action: Action }
  /** JPEG of the visible tab, base64. */
  | { op: "screenshot"; quality: number }
  /** The page's readable prose (protocol 2+). */
  | { op: "read"; max: number }
  | { op: "tab" }
) & { tab?: TabTarget };

export type RemoteResult =
  | { op: "snapshot"; snapshot: RawSnapshot }
  | { op: "execute"; status: string }
  | { op: "screenshot"; jpegBase64: string | null }
  | { op: "read"; page: RawPageText }
  | { op: "tab"; tab: TabInfo | null };

/** companion -> bridge */
export type ToBridge = { type: "exec_req"; id: string; req: RemoteOp } | { type: "ping" };

/** bridge -> companion */
export type FromBridge =
  | { type: "hello"; protocol: number; agent: string; tab: TabInfo | null }
  | { type: "exec_res"; id: string; ok: true; result: RemoteResult }
  | { type: "exec_res"; id: string; ok: false; error: string }
  /** The active tab changed or navigated; the companion refreshes its view. */
  | { type: "tab"; tab: TabInfo | null }
  | { type: "pong" };

/** Element-id contract shared with the Playwright executor. */
export const STALE_ELEMENT = (label: string) => `${label} is no longer on the page`;
