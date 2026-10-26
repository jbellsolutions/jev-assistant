/** The panel's geometry, kept pure so it can be tested: how tall the live pane may be, where on a
 *  letterboxed picture a click landed, and which keystrokes are forwarded to the pictured window. */

/** Neither half may be dragged away: the pane keeps room for a picture, the bottom for the text
 *  box and at least a line of the log. */
export const PANE_MIN = 160;
export const CONTROLS_MIN = 200;

export function clampPane(height: number, available: number): number {
  const max = Math.max(PANE_MIN, available - CONTROLS_MIN);
  return Math.round(Math.min(max, Math.max(PANE_MIN, height)));
}

export const PANE_KEY = "jev.paneHeight";

/** Per-viewer convenience only: storage can be missing or throw (private window, cleared data). */
export function loadPaneHeight(storage: Pick<Storage, "getItem"> | undefined): number | null {
  try {
    const v = Number(storage?.getItem(PANE_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function savePaneHeight(storage: Pick<Storage, "setItem" | "removeItem"> | undefined, height: number | null): void {
  try {
    if (height === null) storage?.removeItem(PANE_KEY);
    else storage?.setItem(PANE_KEY, String(Math.round(height)));
  } catch {
    /* the size just isn't remembered */
  }
}

/** Where a click fell on the picture, as fractions of the picture itself — not of the box around
 *  it. With `object-fit: contain` pinned top-left the picture can be narrower or shorter than its
 *  box; a click in the empty margin is not a click on the window, and must not be sent as one. */
export function frameFraction(
  point: { x: number; y: number },
  box: { left: number; top: number; width: number; height: number },
  natural: { width: number; height: number },
): { fx: number; fy: number } | null {
  if (!box.width || !box.height || !natural.width || !natural.height) return null;
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const w = natural.width * scale;
  const h = natural.height * scale;
  const fx = (point.x - box.left) / w;
  const fy = (point.y - box.top) / h;
  if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return null;
  return { fx, fy };
}

/** Keys the panel passes through to the pictured window, by DOM name. */
const NAMED = new Set(["Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/** A keystroke on the picture: plain characters are typed text; named keys and shortcuts are sent
 *  as a key ("cmd+a"). Null for what isn't forwarded (a bare modifier). */
export function keystroke(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): { text: string } | { key: string } | null {
  const mods = [e.metaKey && "cmd", e.ctrlKey && "ctrl", e.altKey && "option"].filter(Boolean) as string[];
  if (e.key.length === 1 && mods.length === 0) return { text: e.key };
  if (e.key.length === 1) return { key: [...mods, ...(e.shiftKey ? ["shift"] : []), e.key.toLowerCase()].join("+") };
  if (NAMED.has(e.key)) return { key: [...mods, ...(e.shiftKey ? ["shift"] : []), e.key].join("+") };
  return null;
}

/** Zoom steps for the live pane. "fit" fills the box. */
export const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2] as const;
export type Zoom = "fit" | number;

export function stepZoom(z: Zoom, dir: 1 | -1): number {
  const cur = z === "fit" ? 1 : z;
  const i = ZOOMS.findIndex((v) => v >= cur - 1e-9);
  const at = i === -1 ? ZOOMS.length - 1 : i;
  const next = dir === 1 ? (ZOOMS[at] ?? cur) > cur + 1e-9 ? at : at + 1 : at - 1;
  return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, next))]!;
}

/** The co-founder's desktop box at a zoom: "fit" fills the pane; a number is the remote screen's
 *  own size times it (noVNC scales into the box and keeps clicks landing where they're aimed). */
export function vncBox(zoom: Zoom, fb: { width: number; height: number } | null): { width: number; height: number } | null {
  if (zoom === "fit") return null;
  const { width, height } = fb && fb.width > 0 && fb.height > 0 ? fb : { width: 1280, height: 720 };
  return { width: Math.round(width * zoom), height: Math.round(height * zoom) };
}

/** Automatic reconnects for the co-founder's live desktop before falling back to a picture. */
export const VNC_RETRY_MS = [1_000, 2_000, 4_000] as const;

/** A frame older than this, with nothing newer, is labelled "not live". The server resends an
 *  unchanged frame every 5s, so a live picture is never older than that plus a capture. */
export const LIVE_MS = 9_000;

/** "Live" / "Not live — last picture 2m ago (why)", from the frame's time and any reported problem. */
export function freshness(page: { frame: string | null; at?: number; problem?: { reason: string; at: number } | null }, now: number): { live: boolean; text: string } {
  const ago = (t: number) => {
    const s = Math.max(0, Math.round((now - t) / 1000));
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
  };
  const problem = page.problem && (!page.at || page.problem.at >= page.at) ? page.problem : null;
  if (!page.frame) return { live: false, text: problem ? `Not live — ${problem.reason}` : "Waiting for a picture" };
  if (!problem && page.at && now - page.at <= LIVE_MS) return { live: true, text: "Live" };
  return { live: false, text: `Not live — last picture ${page.at ? ago(page.at) : "a while ago"}${problem ? ` (${problem.reason})` : ""}` };
}
