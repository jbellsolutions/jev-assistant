/** The brain's hands: a short, NAMED list and nothing else. Hermes failed with 429 tools hidden
 *  behind a search; this brain gets the handful below, each a thin wrapper over a module Jev's
 *  fast lane already uses and tests.
 *
 *  Two rules live here in code rather than in the prompt:
 *  - Computer use is grounded: elements are acted on by the id a read just returned. There is no
 *    click-by-position tool at all (blind clicks are what put v10 in the wrong Slack workspace).
 *  - Writes ask first. Each tool decides whether this call writes (a risky label, a submit, an
 *    Enter, a shell command off the read-only list) and awaits `ctx.ask()` before acting. The run
 *    stays alive while it waits, so the step cap, the wall clock and Escape all still apply. */
import { execFile } from "node:child_process";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Action, ScrollDirection } from "../../core/actions.js";
import { CONTROL_TARGETS, type Control } from "../../core/controls.js";
import { RISKY_WORDS } from "../../core/decide.js";
import type { PageSnapshot } from "../../core/elements.js";
import type { Executor } from "../../core/executor.js";
import type { Computer } from "../../core/session.js";
import type { BrowserBox, BoxResult } from "../browserbox.js";
import { type Cofounder, DONE_STATES, newRequestId } from "../cofounder.js";
import { ORGO_SCREEN, type OrgoComputer } from "../orgo.js";
import { guardNavigate, hostOf, hostsIn, isErrorPage } from "./hosts.js";
import { hasHandle, type SecretVault } from "./secrets.js";

export interface Hands {
  /** The Mac app in front, through cua-driver. */
  mac: Executor | null;
  /** Read-only visual fallback when a sheet or system dialog cannot expose an app-window tree. */
  screen?: Executor | null;
  /** the user's own Chrome, through the bridge extension: the tab he is looking at. */
  chrome: Executor | null;
  /** The same Chrome, in Jev's own minimized window (same logins, never on screen). The brain's
   *  default: it works here unless the user asks about the tab in front of him. */
  chromeBackground?: Executor | null;
  /** Open apps and files, device controls. */
  computer: Computer | null;
  /** Jev's own browsers (browser-box): public research, JavaScript pages, reusable sign-ins. */
  box?: BrowserBox | null;
  /** The co-founder agent on the user's Orgo computer; null until ORGO_API_KEY is set. */
  cofounder?: Cofounder | null;
  /** That same computer's screen, keyboard and shell — Jev's own hands on it. */
  orgo?: OrgoComputer | null;
}

/** A tool result the model should SEE: text plus a screenshot, sent to the model as an image. */
export interface Seen {
  text: string;
  jpegBase64: string;
}
export function isSeen(v: unknown): v is Seen {
  return !!v && typeof v === "object" && typeof (v as Seen).text === "string" && typeof (v as Seen).jpegBase64 === "string";
}

export interface ToolContext {
  /** Ask the user before a write. Resolves false on "no", on Stop, and when the run ends. */
  ask(summary: string): Promise<boolean>;
  appWriteAllowed?: (slug: string) => boolean;
  signal: AbortSignal;
  /** Where this run's Mac actions are recorded: a screenshot of the window after each one, numbered
   *  in order. `started` once the first is written, so the run log can name the folder. */
  recording?: { dir: string; started: boolean; count: number };
  /** The request id of each hand-off to the co-founder in this run, by its text: a retry of the
   *  same hand-off is the same delivery, never a second task. */
  handoffs?: Map<string, string>;
  /** Every message this run has sent, by its text: the same words are never sent twice in one run.
   *  Live 2026-09-25 one request went out as a DM and then again in #all-agents — both approved,
   *  both unwanted as a pair. */
  sent?: Map<string, string>;
  /** The co-founder was checked (not mid-task, or the user said go ahead) before this run first
   *  acted on its computer. */
  orgoCleared?: boolean;
  /** A chrome page this run landed on (after every call), for the task's memory of real hosts. */
  onPage?: (url: string) => void;
  /** Hosts the task has already been on — with the pages of this run, what the host guard trusts. */
  knownHosts?: () => string[];
  /** Secrets the tools came across, held as handles. `type`, `set` and `shell` fill a handle in at
   *  the last moment; nothing else ever sees the value. */
  secrets?: SecretVault;
  /** A run the co-founder started may not open the user's secrets. */
  secretsLocked?: boolean;
  /** A lead's job works in one Chrome window. "background": his_tab is refused. */
  tab?: "background" | "his_tab";
}

/** A secret's value in place of its handle, for the executor only — or why it can't be. */
export function fillSecrets(ctx: ToolContext, text: string): { text: string } | { error: string } {
  if (!hasHandle(text)) return { text };
  if (ctx.secretsLocked) return { error: "Secrets aren't available to requests from the co-founder. Tell it the user has to do this step." };
  if (!ctx.secrets) return { error: "No secrets are held in this run." };
  return ctx.secrets.reveal(text);
}

const HIS_TAB_REFUSED =
  "This job works in Jev's own Chrome window (tab: background) and the user didn't ask for his tab. Stay in the background window — his tab is his. If the work really needs his tab, report needs_input and say why.";

/** How long a screen is given to react before the after-picture is taken. */
export const ORGO_SETTLE_MS = 700;
const ORGO_OFF = "The co-founder's computer isn't connected to Jev (no ORGO_API_KEY). Tell the user.";

/** Normalised for "is this the same message": case, spacing and a leading mention don't matter. */
export function sentKey(text: string): string {
  return text.toLowerCase().replace(/^@\S+\s*/, "").replace(/\s+/g, " ").trim();
}

/** Refuses a second send of the same words in one run; null when this one may go. */
export function alreadySent(ctx: ToolContext, text: string): string | null {
  const key = sentKey(text);
  if (!key) return null;
  const where = ctx.sent?.get(key);
  return where ? `Already sent "${text.trim()}" to ${where} in this run. Do not send it again — tell the user it went there, and only send another copy if he asks.` : null;
}

export function recordSent(ctx: ToolContext, text: string, where: string): void {
  const key = sentKey(text);
  if (key) (ctx.sent ??= new Map()).set(key, where);
}

/** A send, for the guard: typed text with Enter. */
const sends = (action: Action): action is Extract<Action, { kind: "type" }> => action.kind === "type" && action.submit;

/** The Mac surface's brain-only side: work in a NAMED app without bringing it forward. The fast
 *  lane keeps using the plain Executor (the app in front, where the user is looking). */
export interface MacApps {
  readApp(app: string | null, opts?: { query?: string }): Promise<{ snapshot: PageSnapshot; text: string; menus: string[]; app: string }>;
  reread(): Promise<{ snapshot: PageSnapshot; text: string; menus: string[]; app: string }>;
  actInApp(action: Action): Promise<string>;
  menu(path: string[]): Promise<string>;
  /** Click a line of on-screen text that has no id (a Slack DM row), in the background. */
  clickText(text: string): Promise<string>;
  setValue(elementId: string, label: string, value: string): Promise<string>;
  launch(name: string): Promise<string>;
  captureTo(file: string): Promise<void>;
}

export function hasMacApps(m: unknown): m is MacApps & Executor {
  return !!m && typeof (m as MacApps).readApp === "function" && typeof (m as MacApps).actInApp === "function";
}

/** Give the window a moment to redraw before reading what an action changed. */
const SETTLE_MS = 400;

/** The whole list, in order. Logged at startup with its count, and asserted in tests. */
export const TOOL_NAMES = ["mac_read", "mac_act", "mac_control", "chrome", "browser_box", "shell", "cofounder", "orgo", "secret"] as const;

/** Said when there is no co-founder to hand to — honest, and actionable by the user. */
export const COFOUNDER_OFF = "The co-founder isn't connected yet: Jev needs ORGO_API_KEY in its .env (then a rebuild). Tell the user that; don't try to reach it another way.";

/** Elements handed to the model per read. Enough to find a channel list; small enough to stay cheap. */
const MAX_ELEMENTS_SHOWN = 150;
/** Page text handed back per read. */
const MAX_TEXT = 6_000;
const SHELL_TIMEOUT_MS = 30_000;
const MAX_SHELL_OUTPUT = 8_000;

/** Commands that only look. Anything else — and anything with a pipe into another program, a
 *  redirect or a substitution — asks first. */
export const READ_ONLY_COMMANDS = new Set(["ls", "cat", "head", "tail", "wc", "pwd", "date", "whoami", "find", "grep", "rg", "mdfind", "mdls", "du", "df", "stat", "file", "which", "uptime", "sw_vers", "echo", "uname"]);

export function shellIsReadOnly(command: string): boolean {
  const c = command.trim();
  if (!c || /[;&|`<>]|\$\(/.test(c)) return false;
  if (c === "hostname") return true; // bare only: "hostname X" renames the machine
  const first = c.split(/\s+/)[0]!;
  if (!READ_ONLY_COMMANDS.has(first)) return false;
  // find can delete and exec
  if (first === "find" && /\s-(delete|exec|execdir|ok|okdir|fprint)\b/.test(c)) return false;
  return true;
}

/** A field whose Enter runs a search rather than sending anything: Slack's "Search query", Gmail's
 *  "Search mail", a browser's address bar. Asking before every search stalled the user's own "check
 *  Slack" — he was asked to approve typing a name into the search box, said no, and the run ended. */
const SEARCH_FIELD = /\b(?:search|find|filter|look ?up|jump to)\b|address and search bar/;

/** Does this action write — i.e. could it send, post, delete or submit something? */
export function actionWrites(action: Action): boolean {
  switch (action.kind) {
    case "click":
      return RISKY_WORDS.test(action.label.toLowerCase());
    case "type": {
      if (!action.submit) return false;
      // Enter in a search field searches. A field whose label also names a write ("search and send")
      // still asks, and so does a field with no label at all.
      const label = (action.label ?? "").toLowerCase();
      return !(SEARCH_FIELD.test(label) && !RISKY_WORDS.test(label) && !/\b(?:message|reply|comment)\b/.test(label));
    }
    case "press":
      return /^(enter|return)$/i.test(action.key);
    default:
      return false;
  }
}

/** A link in a Mac app that names a web address opens the user's browser IN FRONT — the one thing
 *  background work must not do. Live 2026-09-25: "check Slack" clicked "Verifully.com" in a message.
 *  In-app links (#channel, @person) stay clickable. */
export function opensBrowser(label: string): boolean {
  return /^(https?:\/\/|www\.)|^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(label.trim());
}
export const OPENS_BROWSER =
  "That link opens a web page in the user's browser, in front of him. Don't click it — open the address with chrome (Jev's own window) or browser_box instead.";

/** A Mac read as the model sees it: the ids to act on, then what the window says, then its menus. */
/** The window in front, as text — what the co-founder's jev_look sees. Read-only. */
export async function lookAtMac(mac: Executor | null): Promise<string> {
  if (!mac) return "Mac control is off on this machine.";
  if (mac.ready === false) return "The Mac isn't reachable right now (cua-driver is not answering).";
  if (hasMacApps(mac)) return renderMacRead(await mac.readApp(null, {}));
  return renderSnapshot(await mac.snapshot());
}

export function renderMacRead(r: { snapshot: PageSnapshot; text: string; menus: string[] }): string {
  const text = r.text ? `\nText on screen:\n${r.text}` : "\n(no text on screen)";
  const menus = r.menus.length ? `\nApp menus (mac_act menu with a path, e.g. ["${r.menus[0]}", "…"]): ${r.menus.join(", ")}` : "";
  return `${renderSnapshot(r.snapshot, MAC_ELEMENTS_SHOWN)}${text}${menus}`;
}

/** Elements per Mac read: fewer than a page's, because the window's text now comes along too. */
const MAC_ELEMENTS_SHOWN = 120;

/** A snapshot as the model sees it: one compact line per element. */
export function renderSnapshot(s: PageSnapshot, max = MAX_ELEMENTS_SHOWN): string {
  const rows = s.elements.slice(0, max).map((e) => {
    const name = (e.label || e.text || e.placeholder || e.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const kind = e.role || e.tag;
    const value = e.value === undefined ? "" : e.value === "" ? " (empty)" : ` = "${e.value.replace(/\s+/g, " ").slice(0, 120)}"`;
    return `${e.id} ${kind}${name ? ` "${name}"` : ""}${value}${e.hrefShort ? ` → ${e.hrefShort}` : ""}`;
  });
  const more = s.elements.length > max ? `\n… ${s.elements.length - max} more not shown` : "";
  const dialogs = s.dialogs?.length ? `\nDialogs: ${s.dialogs.join(" | ")}` : "";
  return `${s.title || "(untitled)"} — ${s.url}\n${rows.join("\n")}${more}${dialogs}`;
}

const actSchema = z.object({
  action: z.enum(["click", "type", "key", "scroll"]).describe("What to do"),
  element_id: z.string().optional().describe("For click/type: the id from the last read, e.g. e12"),
  text: z.string().optional().describe("For type: the text to type"),
  submit: z.boolean().optional().describe("For type: press Enter after typing (this sends/submits, so it is checked first)"),
  key: z.string().optional().describe("For key: e.g. Enter, Escape, Tab, cmd+k"),
  direction: z.enum(["up", "down", "top", "bottom"]).optional().describe("For scroll"),
});
type ActInput = z.infer<typeof actSchema>;

/** Turn a tool call into Jev's own Action, using the last read for the element's label. */
export function toAction(input: ActInput, last: PageSnapshot | null): Action | string {
  const find = (id: string | undefined) => (id ? last?.elements.find((e) => e.id === id) : undefined);
  switch (input.action) {
    case "click": {
      const el = find(input.element_id);
      if (!el) return last ? `No element ${input.element_id ?? "(none given)"} in the last read — read again and use an id from it.` : "Read first, then act on an element id from what you read.";
      return { kind: "click", elementId: el.id, label: el.label || el.text || el.id };
    }
    case "type": {
      if (typeof input.text !== "string") return "type needs text.";
      const el = input.element_id ? find(input.element_id) : undefined;
      if (input.element_id && !el) return `No element ${input.element_id} in the last read — read again.`;
      return { kind: "type", elementId: el?.id ?? null, label: el ? el.label || el.text || el.id : null, text: input.text, submit: !!input.submit };
    }
    case "key":
      return input.key ? { kind: "press", key: input.key } : "key needs a key name.";
    case "scroll":
      return { kind: "scroll", direction: (input.direction ?? "down") as ScrollDirection };
  }
}

function describeWrite(action: Action, where: string): string {
  switch (action.kind) {
    case "click":
      return `click "${action.label}" in ${where}`;
    case "type":
      return `type "${action.text}"${action.label ? ` into ${action.label}` : ""} and press Enter in ${where}`;
    case "press":
      return `press ${action.key} in ${where}`;
    default:
      return `${action.kind} in ${where}`;
  }
}

export function buildTools(hands: Hands, ctx: ToolContext): ToolSet {
  let lastMac: PageSnapshot | null = null;
  let lastChrome: PageSnapshot | null = null;
  let lastChromeTab: "background" | "his_tab" | null = null;
  const stopped = () => (ctx.signal.aborted ? "Stopped." : null);
  /** What a Mac action left behind, as `<dir>/01-click.png`, `02-menu.png`… A capture that fails
   *  never blocks the action or the answer. */
  const record = async (mac: MacApps, what: string): Promise<void> => {
    const rec = ctx.recording;
    if (!rec) return;
    const n = ++rec.count;
    try {
      await mac.captureTo(`${rec.dir}/${String(n).padStart(2, "0")}-${what}.png`);
      rec.started = true;
    } catch {
      /* the screenshot is evidence, not the work */
    }
  };

  /** The action as the executor gets it: a typed handle becomes the secret's value. */
  const withSecrets = (action: Action): Action | string => {
    if (action.kind !== "type") return action;
    const f = fillSecrets(ctx, action.text);
    return "error" in f ? f.error : { ...action, text: f.text };
  };

  // Chrome: hosts the pages of this run landed on or showed, and the last page that loaded.
  const pageHosts = new Set<string>();
  let lastGood: string | null = null;
  const known = () => [...pageHosts, ...(ctx.knownHosts?.() ?? [])];
  const landed = (url: string) => {
    const host = hostOf(url);
    if (!host || isErrorPage(url)) return;
    pageHosts.add(host);
    lastGood = url;
    ctx.onPage?.(url);
  };
  const errorPage = (url: string, detail: string) =>
    `That address didn't load — Chrome showed its error page for ${url} (${detail.replace(/\s+/g, " ").slice(0, 160)}). The hostname or path is wrong: this is NOT a login, session or "still setting up" problem. ${lastGood ? `Go back to the last page that worked, ${lastGood}, and reach the page from there by clicking` : "Open a page you know works and reach the page from there by clicking"}, or use an address you saw on a page.`;

  /** Where a navigation actually landed — an error page is said to be one, a real page is learned. */
  const whereNow = async (chrome: Executor, meant: string): Promise<string> => {
    if (!chrome.capabilities.read || !chrome.read) {
      landed(chrome.url);
      return `Now on ${chrome.url}`;
    }
    try {
      const t = await chrome.read(400);
      if (isErrorPage(t.url, t.title)) return errorPage(t.url || meant, t.title);
      landed(t.url);
      return `Now on: ${t.title || "(untitled)"} — ${t.url}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return isErrorPage(meant, msg) ? errorPage(meant, msg) : `(couldn't read where it landed: ${msg})`;
    }
  };

  const act = async (surface: Executor, input: ActInput, last: PageSnapshot | null, where: string): Promise<string> => {
    const action = toAction(input, last);
    if (typeof action === "string") return action;
    if (sends(action)) {
      const dup = alreadySent(ctx, action.text);
      if (dup) return dup;
    }
    if (actionWrites(action) && !(await ctx.ask(describeWrite(action, where)))) return "the user said no. Do not do this another way; stop and tell him.";
    if (ctx.signal.aborted) return "Stopped.";
    const filled = withSecrets(action);
    if (typeof filled === "string") return filled;
    const done = await surface.execute(filled);
    if (sends(action)) recordSent(ctx, action.text, action.label ? `${action.label} in ${where}` : where);
    return done;
  };

  return {
    mac_read: tool({
      description:
        'Inspect the connected Mac. Read a Mac app: elements, text and menus. Set screen:true to SEE a screenshot of that window as well, especially when asked what you can see. Pass app (e.g. "Slack") to read that app IN THE BACKGROUND. Omit app for the app in front. query narrows the read to matching rows.',
      inputSchema: z.object({
        app: z.string().optional().describe("The app by name, e.g. Slack. Read in the background."),
        query: z.string().optional().describe("Only rows containing this text, e.g. unread"),
        screen: z.boolean().optional().describe("Include an actual screenshot of this Mac window to inspect visually."),
      }),
      execute: async (input) => {
        if (stopped()) return "Stopped.";
        if (!hands.mac || hands.mac.ready === false) {
          const reason = !hands.mac ? "Mac app control is off on this machine." : "Mac accessibility control is unavailable right now.";
          if (input.screen && hands.screen) { const image = await hands.screen.screenshot(); if (image?.length) return { text: `${reason} This is a picture of the Mac primary display only; it does not establish app-control permission.`, jpegBase64: Buffer.from(image).toString("base64") }; }
          return reason;
        }
        let text: string;
        try { if (hasMacApps(hands.mac)) {
          const r = await hands.mac.readApp(input.app ?? null, input.query ? { query: input.query } : {});
          lastMac = r.snapshot;
          text = renderMacRead(r);
        } else { lastMac = await hands.mac.snapshot(); text = renderSnapshot(lastMac); } }
        catch (error) {
          if (!input.screen) throw error;
          lastMac = null; text = "The app-window accessibility read was unavailable. The following is an observation of the Mac display; do not invent element IDs.";
        }
        if (input.screen) {
          let image = lastMac ? await hands.mac.screenshot().catch(() => null) : null;
          if (!image?.length && hands.screen) { image = await hands.screen.screenshot(); if (image?.length) text += "\nVisual source: the Mac primary display, including any dialogs, not an isolated app window."; }
          if (image?.length) return { text, jpegBase64: Buffer.from(image).toString("base64") };
          return `${text}\nScreenshot unavailable: ${hands.mac.frameProblem || "check Screen Recording permission on the Mac"}. This is an accessibility-text observation, not a picture.`;
        }
        return text;
      },
      toModelOutput: ({ output }: { output: Seen | string }) => isSeen(output)
        ? { type: "content" as const, value: [{ type: "text" as const, text: output.text }, { type: "file" as const, mediaType: "image/jpeg", data: { type: "data" as const, data: output.jpegBase64 } }] }
        : { type: "text" as const, value: String(output) },
    }),

    mac_act: tool({
      description:
        "Act in the app you last read with mac_read, in the background: click, type (submit presses Enter), key, scroll — on an element id from that read; click with text (and no element_id) clicks a line from \"Text on screen\" that has no id, e.g. a conversation in a list; menu chooses an app-menu path; set puts a value straight into a field, popup, slider or date. Every action returns what the window looks like afterwards, so you do not need to read again. open_app opens an app without bringing it forward; open_file opens a file.",
      inputSchema: actSchema.extend({
        action: z.enum(["click", "type", "key", "scroll", "menu", "set", "open_app", "open_file"]),
        name: z.string().optional().describe("For open_app / open_file: the app or file name"),
        path: z.array(z.string()).optional().describe('For menu: the menu path, e.g. ["File", "New Message"]'),
        value: z.string().optional().describe("For set: the value to put in the element"),
      }),
      execute: async (input) => {
        if (stopped()) return "Stopped.";
        const mac = hands.mac;
        if (input.action === "open_app" || input.action === "open_file") {
          if (!input.name) return `${input.action} needs a name.`;
          if (input.action === "open_app" && hasMacApps(mac)) return mac.launch(input.name);
          const computer = hands.computer;
          if (!computer) return "Opening apps and files is off on this machine.";
          if (input.action === "open_app") return computer.openApp(input.name);
          const found = await computer.findFiles(input.name);
          if (found.length === 0) return `No file called ${input.name}.`;
          if (found.length > 1) return `Several files match — ask the user which: ${found.join(" | ")}`;
          return computer.openPath(found[0]!);
        }
        if (!mac) return "Mac control is off on this machine.";
        if (!hasMacApps(mac)) {
          if (input.action === "menu" || input.action === "set") return `${input.action} isn't available on this Mac surface.`;
          return act(mac, input as ActInput, lastMac, "the Mac app in front");
        }
        const where = lastMac?.url.replace(/^app:\/\//, "") || "the Mac app";
        if (!lastMac) return "Read the app first (mac_read with app), then act on an id from that read.";
        let done: string;
        if (input.action === "click" && !input.element_id && input.text) {
          // A row with no id: its text, as the read showed it under "Text on screen".
          if (RISKY_WORDS.test(input.text.toLowerCase()) && !(await ctx.ask(`click "${input.text}" in ${where}`))) return "the user said no. Do not do this another way; stop and tell him.";
          if (ctx.signal.aborted) return "Stopped.";
          try {
            done = await mac.clickText(input.text);
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        } else if (input.action === "menu") {
          const path = (input.path ?? []).map((p) => p.trim()).filter(Boolean);
          if (!path.length) return 'menu needs a path, e.g. ["File", "New"].';
          if (RISKY_WORDS.test(path[path.length - 1]!.toLowerCase()) && !(await ctx.ask(`choose ${path.join(" › ")} in ${where}`))) return "the user said no. Do not do this another way; stop and tell him.";
          if (ctx.signal.aborted) return "Stopped.";
          done = await mac.menu(path);
        } else if (input.action === "set") {
          const el = lastMac.elements.find((e) => e.id === input.element_id);
          if (!el) return `No element ${input.element_id ?? "(none given)"} in the last read — read again and use an id from it.`;
          if (typeof input.value !== "string") return "set needs a value.";
          const label = el.label || el.text || el.placeholder || el.id;
          if (RISKY_WORDS.test(label.toLowerCase()) && !(await ctx.ask(`set ${label} to "${input.value}" in ${where}`))) return "the user said no. Do not do this another way; stop and tell him.";
          if (ctx.signal.aborted) return "Stopped.";
          const value = fillSecrets(ctx, input.value);
          if ("error" in value) return value.error;
          done = await mac.setValue(el.id, label, value.text);
        } else {
          const action = toAction(input as ActInput, lastMac);
          if (typeof action === "string") return action;
          const target = action.kind === "click" ? lastMac.elements.find((e) => e.id === action.elementId) : undefined;
          if (target?.role === "link" && opensBrowser(action.kind === "click" ? action.label : "")) return OPENS_BROWSER;
          if (sends(action)) {
            const dup = alreadySent(ctx, action.text);
            if (dup) return dup;
          }
          if (actionWrites(action) && !(await ctx.ask(describeWrite(action, where)))) return "the user said no. Do not do this another way; stop and tell him.";
          if (ctx.signal.aborted) return "Stopped.";
          const filled = withSecrets(action);
          if (typeof filled === "string") return filled;
          done = await mac.actInApp(filled);
          if (sends(action)) recordSent(ctx, action.text, action.label ? `${action.label} in ${where}` : where);
        }
        // one step per action: hand back what the window looks like now
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        if (ctx.signal.aborted) return done;
        await record(mac, input.action);
        try {
          const after = await mac.reread();
          lastMac = after.snapshot;
          return `${done}\n\nNow:\n${renderMacRead(after)}`;
        } catch (err) {
          return `${done}\n(could not re-read the window: ${err instanceof Error ? err.message : String(err)})`;
        }
      },
    }),

    mac_control: tool({
      description: "This Mac's volume, media playback, dark mode, lock and sleep.",
      inputSchema: z.object({
        target: z.enum(CONTROL_TARGETS.filter((t) => t !== "timer") as [string, ...string[]]),
        action: z.string().describe("volume: up|down|mute|unmute|set · media: play|pause|next|previous · display: dark_on|dark_off|toggle · system: lock|sleep"),
        level: z.number().min(0).max(100).optional().describe("For volume set: 0–100"),
      }),
      execute: async (input) => {
        if (stopped()) return "Stopped.";
        if (!hands.computer?.control) return "Device controls are off on this machine.";
        const control = { target: input.target, action: input.action, ...(input.level !== undefined ? { level: input.level } : {}) } as unknown as Control;
        return hands.computer.control(control);
      },
    }),

    chrome: tool({
      description:
        "the user's own Chrome, with all his logins. By default you work in Jev's OWN background window of it (tab: background) — minimized, so his screen, tabs and mouse are untouched; navigate there first. Use tab: his_tab only to read or act on the page he is looking at (\"this page\", \"my tab\"). read_elements lists what can be clicked, with ids, and what each field holds now; read_text returns the page's readable text. navigate opens a URL — only one you were given, saw on a page, or landed on; never a guessed hostname. click/type/key/scroll act on an id from the last read_elements; after type you're told what the field actually holds.",
      inputSchema: actSchema.extend({
        action: z.enum(["read_elements", "read_text", "navigate", "back", "click", "type", "key", "scroll"]),
        url: z.string().optional().describe("For navigate"),
        tab: z.enum(["background", "his_tab"]).optional().describe("background (default): Jev's own window. his_tab: the tab the user is looking at."),
      }),
      execute: async (input) => {
        if (stopped()) return "Stopped.";
        // one tab per job: a background job stays in Jev's window
        const asked = input.tab ?? ctx.tab ?? "background";
        if (ctx.tab === "background" && asked === "his_tab") return HIS_TAB_REFUSED;
        const which = asked === "his_tab" || !hands.chromeBackground ? "his_tab" : "background";
        const chrome = which === "background" ? hands.chromeBackground! : hands.chrome;
        if (!chrome || chrome.ready === false) return "the user's Chrome isn't connected (the Jev bridge extension is not attached). Say so and stop.";
        if (chrome.readHint && !chrome.capabilities.read) return chrome.readHint;
        // ids belong to the tab they were read from
        if (lastChromeTab !== which) lastChrome = null;
        lastChromeTab = which;
        const failed = (err: unknown, url: string): string => {
          const msg = err instanceof Error ? err.message : String(err);
          if (isErrorPage(url, msg)) return errorPage(url, msg);
          throw err;
        };
        switch (input.action) {
          case "read_elements": {
            try {
              lastChrome = await chrome.snapshot();
            } catch (err) {
              return failed(err, chrome.url);
            }
            if (isErrorPage(lastChrome.url, lastChrome.title)) return errorPage(lastChrome.url, lastChrome.title);
            landed(lastChrome.url);
            const out = renderSnapshot(lastChrome);
            for (const h of hostsIn(out)) pageHosts.add(h);
            return out;
          }
          case "read_text": {
            if (!chrome.capabilities.read || !chrome.read) return chrome.readHint ?? "This Chrome bridge cannot read page text.";
            let t;
            try {
              t = await chrome.read(MAX_TEXT);
            } catch (err) {
              return failed(err, chrome.url);
            }
            if (isErrorPage(t.url, t.title)) return errorPage(t.url, t.title);
            landed(t.url);
            for (const h of hostsIn(t.text)) pageHosts.add(h);
            return `${t.title} — ${t.url}\n${t.text}${t.truncated ? `\n… (${t.chars - t.text.length} more characters)` : ""}`;
          }
          case "navigate": {
            if (!input.url) return "navigate needs a url.";
            const url = /^[a-z]+:\/\//i.test(input.url) ? input.url : `https://${input.url}`;
            const refused = guardNavigate(url, known());
            if (refused) return refused;
            let status: string;
            try {
              status = await chrome.execute({ kind: "navigate", url });
            } catch (err) {
              return failed(err, url);
            }
            return `${status}\n${await whereNow(chrome, url)}`;
          }
          case "back": {
            const status = await chrome.execute({ kind: "back" });
            return `${status}\n${await whereNow(chrome, chrome.url)}`;
          }
          default: {
            const acted = await act(chrome, input as ActInput, lastChrome, which === "background" ? "Chrome (Jev's window)" : "Chrome");
            // a click or a submit can land somewhere new (a login, a redirect): learn it, say it
            const moved = chrome.url !== lastChrome?.url && /^https?:/i.test(chrome.url);
            if (moved) landed(chrome.url);
            const done = moved ? `${acted}\nNow on ${chrome.url}` : acted;
            if (input.action !== "type" || !input.element_id || input.submit || !lastChrome) return done;
            // read the field back: what actually landed, not what was meant to
            const before = lastChrome.elements.find((e) => e.id === input.element_id);
            try {
              const after = await chrome.snapshot();
              const el = after.elements.find((e) => e.id === input.element_id);
              lastChrome = after;
              if (!before || !el || el.value === undefined || (el.label || el.placeholder || el.name) !== (before.label || before.placeholder || before.name)) return done;
              return `${done}\nThe field now holds: ${el.value === "" ? "(nothing)" : `"${el.value}"`}`;
            } catch {
              return done;
            }
          }
        }
      },
    }),

    browser_box: tool({
      description:
        "Jev's OWN browsers, separate from the user's Chrome. fetch: plain HTTP GET, fastest, for server-rendered pages. read: open a URL in a real browser and get its text and links (pages that need JavaScript). act: drive that browser in plain steps you plan, e.g. \"open https://…\", \"click the Pricing link\", \"type 'x' into the search box and press enter\" (up to 4 joined by then). session_create / session_list / session_release: a persistent signed-in browser the user logs into once. Use this for public research and anything not behind the user's own Chrome logins.",
      inputSchema: z.object({
        action: z.enum(["fetch", "read", "act", "pick", "session_create", "session_list", "session_release", "status"]),
        url: z.string().optional().describe("For fetch / read"),
        command: z.string().optional().describe("For act: one step, or up to 4 joined by then"),
        pick: z.string().optional().describe("For pick: answers a needs_clarification with one option's pick value"),
        session_id: z.string().optional().describe("For session_release"),
      }),
      execute: async (input) => {
        if (stopped()) return "Stopped.";
        const box = hands.box;
        if (!box) return "browser-box isn't configured on this Mac (no BB_TOKEN). Say so and stop.";
        const s = ctx.signal;
        switch (input.action) {
          case "fetch":
          case "read":
            if (!input.url) return `${input.action} needs a url.`;
            return renderBoxPage(await box.call(input.action, { url: input.url }, s));
          case "act": {
            if (!input.command) return "act needs a command.";
            let r = await box.call("act", { command: input.command }, s);
            // browser-box's own risk check parks a hard-to-undo step (buy, delete, send, post); the
            // answer is the user's, through the same gate as every other write.
            if (r.status === "needs_confirmation") {
              const ok = await ctx.ask(`${String(r.action ?? input.command).replace(/^\w/, (c) => c.toLowerCase())} in Jev's own browser`);
              if (ctx.signal.aborted) return "Stopped.";
              r = await box.call("act", { confirm: ok }, s);
              if (!ok) return "the user said no. Do not do this another way; stop and tell him.";
            }
            return renderBoxAct(r);
          }
          case "pick":
            if (!input.pick) return "pick needs a pick value from the options.";
            return renderBoxAct(await box.call("act", { pick: input.pick }, s));
          case "session_create":
            return JSON.stringify(await box.call("session", { action: "create" }, s));
          case "session_list":
            return JSON.stringify(await box.call("session", { action: "list" }, s));
          case "session_release":
            if (!input.session_id) return "session_release needs a session_id.";
            return JSON.stringify(await box.call("session", { action: "release", session_id: input.session_id }, s));
          case "status":
            return JSON.stringify(await box.call("status", null, s));
        }
      },
    }),

    shell: tool({
      description: "Run a shell command on this Mac. Read-only commands (ls, cat, grep, find, mdfind…) run straight away; anything else is checked with the user first.",
      inputSchema: z.object({ command: z.string().describe("A single shell command") }),
      execute: async ({ command }) => {
        if (stopped()) return "Stopped.";
        // a command carrying a secret always asks, whatever it looks like
        if ((hasHandle(command) || !shellIsReadOnly(command)) && !(await ctx.ask(`run this on your Mac: ${command}`))) return "the user said no. Do not run it another way; stop and tell him.";
        if (ctx.signal.aborted) return "Stopped.";
        const filled = fillSecrets(ctx, command);
        if ("error" in filled) return filled.error;
        return runShell(filled.text, ctx.signal);
      },
    }),

    secret: tool({
      description:
        'Keys, secrets and passwords you come across are never shown to you: they appear as handles like {{secret:s3 …4f2a}}. To use one, write its handle where the value goes — in chrome/mac_act type, mac_act set, or a shell command — and it is filled in at the last moment. name gives a handle a lasting name (e.g. sf_consumer_key) so the next step or job can use {{secret:sf_consumer_key}}; list shows what is held. Never ask for or repeat a secret\'s value.',
      inputSchema: z.object({
        action: z.enum(["name", "list"]),
        handle: z.string().optional().describe("For name: the handle as shown, e.g. {{secret:s3 …4f2a}} or s3"),
        name: z.string().optional().describe("For name: e.g. sf_consumer_key"),
      }),
      execute: async (input) => {
        if (!ctx.secrets) return "No secrets are held in this run.";
        if (ctx.secretsLocked) return "Secrets aren't available to requests from the co-founder.";
        if (input.action === "list") return `Held: ${ctx.secrets.list()}`;
        if (!input.handle || !input.name) return "name needs a handle and a name.";
        return ctx.secrets.name(input.handle, input.name);
      },
    }),

    orgo: tool({
      description: `Your own hands on the co-founder's Orgo computer (a Linux desktop, ${ORGO_SCREEN.width}×${ORGO_SCREEN.height}): look at its screen, click, type, press keys, scroll, or run a shell command there. Use this when the user says to do something ON the co-founder's computer / the Orgo computer — do it yourself; hand a task to the co-founder (the cofounder tool) only when he asks the co-founder to do it. Start with "screenshot" to see the screen; every action returns a fresh screenshot so you see what changed. Coordinates are pixels on that screenshot. Keys look like "Enter", "ctrl+l", "alt+Tab". Shell commands that change anything are checked with the user first.`,
      inputSchema: z.object({
        action: z.enum(["screenshot", "click", "double_click", "right_click", "type", "key", "scroll", "bash"]),
        x: z.number().optional().describe("Pixels from the left (click, scroll)"),
        y: z.number().optional().describe("Pixels from the top (click, scroll)"),
        text: z.string().optional().describe("What to type"),
        key: z.string().optional().describe('A key or combo, e.g. "Enter", "ctrl+l"'),
        direction: z.enum(["up", "down", "left", "right"]).optional(),
        amount: z.number().optional().describe("Scroll steps, default 3"),
        command: z.string().optional().describe("A shell command to run there (bash)"),
      }),
      execute: async (input): Promise<Seen | string> => {
        if (stopped()) return "Stopped.";
        const o = hands.orgo;
        if (!o) return ORGO_OFF;
        const s = ctx.signal;
        const need = (v: number | undefined, name: string) => {
          if (v === undefined) throw new Error(`${input.action} needs ${name}.`);
          return v;
        };
        const look = async (did: string): Promise<Seen> => {
          if (did !== "screen") await new Promise((r) => setTimeout(r, ORGO_SETTLE_MS));
          const shot = await o.screenshot(s);
          return { text: did === "screen" ? `The co-founder's computer's screen (${shot.width}×${shot.height}):` : `${did}. The screen now:`, jpegBase64: shot.jpegBase64 };
        };
        if (input.action === "screenshot") return look("screen");
        // Before the first thing that changes its computer: is the co-founder using it right now?
        if (!ctx.orgoCleared && hands.cofounder) {
          const busy = await hands.cofounder.busy().catch(() => null);
          if (busy && !(await ctx.ask(`act on the co-founder's computer while it's working on "${busy.body.slice(0, 100)}"`))) return "the user said not while the co-founder is working. Stop and tell him.";
          if (s.aborted) return "Stopped.";
        }
        ctx.orgoCleared = true;
        switch (input.action) {
          case "click":
          case "double_click":
          case "right_click":
            await o.click(need(input.x, "x"), need(input.y, "y"), { button: input.action === "right_click" ? "right" : "left", double: input.action === "double_click" }, s);
            return look(`${input.action === "click" ? "Clicked" : input.action === "double_click" ? "Double-clicked" : "Right-clicked"} at ${Math.round(input.x!)},${Math.round(input.y!)}`);
          case "type":
            if (!input.text) return "type needs text.";
            await o.type(input.text, s);
            return look(`Typed ${JSON.stringify(input.text.slice(0, 60))}`);
          case "key":
            if (!input.key) return "key needs a key.";
            await o.key(input.key, s);
            return look(`Pressed ${input.key}`);
          case "scroll":
            await o.scroll(input.x ?? ORGO_SCREEN.width / 2, input.y ?? ORGO_SCREEN.height / 2, input.direction ?? "down", input.amount ?? 3, s);
            return look(`Scrolled ${input.direction ?? "down"}`);
          case "bash": {
            const command = input.command?.trim();
            if (!command) return "bash needs a command.";
            if (!shellIsReadOnly(command) && !(await ctx.ask(`run this on the co-founder's computer: ${command}`))) return "the user said no. Do not run it another way; stop and tell him.";
            if (s.aborted) return "Stopped.";
            return o.bash(command, 60, s);
          }
        }
      },
      toModelOutput: ({ output }: { output: Seen | string }) =>
        isSeen(output)
          ? { type: "content" as const, value: [{ type: "text" as const, text: output.text }, { type: "file" as const, mediaType: "image/jpeg", data: { type: "data" as const, data: output.jpegBase64 } }] }
          : { type: "text" as const, value: String(output) },
    }),

    cofounder: tool({
      description:
        "Hand a task to the user's co-founder: the head agent of his Hermes Studio, on his always-on Orgo cloud computer, with its own computer, browser and teammates. Use it for long or off-Mac work, research, and anything on the co-founder's computer — not for his Mac or his Chrome, which are yours. the user is asked first. Returns the reply if it comes within about a minute; otherwise the task is handed off and the reply is posted to his panel when it lands — say so and stop, don't wait.",
      inputSchema: z.object({ message: z.string().min(1).max(4000).describe("The task, written for the co-founder: what to do and what to send back") }),
      execute: async ({ message }) => {
        if (stopped()) return "Stopped.";
        const c = hands.cofounder;
        if (!c) return COFOUNDER_OFF;
        const dup = alreadySent(ctx, message);
        if (dup) return dup;
        if (!(await ctx.ask(`hand this to the co-founder: "${message}"`))) return "the user said no. Do not do this another way; stop and tell him.";
        if (ctx.signal.aborted) return "Stopped.";
        const key = sentKey(message);
        const handoffs = (ctx.handoffs ??= new Map());
        const id = handoffs.get(key) ?? newRequestId();
        handoffs.set(key, id);
        let d;
        try {
          d = await c.send(message, id);
        } catch (err) {
          return `Couldn't reach the co-founder: ${err instanceof Error ? err.message : String(err)}`;
        }
        recordSent(ctx, message, "the co-founder");
        if (!DONE_STATES.has(d.state)) {
          c.watch(id, message);
          return "Handed to the co-founder; it's working on it. Its reply will be posted to the user's panel when it lands. Tell him that — don't wait for it.";
        }
        if (d.state === "complete") return `The co-founder replied:\n${d.result || "(an empty reply)"}`;
        if (d.state === "needs_review") return "The co-founder's Studio restarted mid-task and is holding it for the user's review in the Studio app. Tell him that.";
        return `The co-founder's task ended ${d.state}${d.result ? `: ${d.result}` : ""}.`;
      },
    }),
  };
}

export function runShell(command: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    execFile("/bin/zsh", ["-c", command], { timeout: SHELL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, signal }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
      const clipped = out.length > MAX_SHELL_OUTPUT ? `${out.slice(0, MAX_SHELL_OUTPUT)}\n… (${out.length - MAX_SHELL_OUTPUT} more characters)` : out;
      if (err && (err as { name?: string }).name === "AbortError") return resolve("Stopped.");
      resolve(err ? `exit ${(err as { code?: unknown }).code ?? "error"}${clipped ? `\n${clipped}` : ""}` : clipped || "(no output)");
    });
  });
}

/** A fetched or read page, as the model sees it. */
export function renderBoxPage(r: BoxResult): string {
  const text = String(r.text ?? "");
  const links = Array.isArray(r.links) ? (r.links as unknown[]).slice(0, 20).map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") : "";
  const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (${text.length - MAX_TEXT} more characters)` : text;
  return `${r.title ?? ""} — ${r.final_url ?? ""} (HTTP ${r.status_code ?? "?"})\n${clipped}${links ? `\nLinks:\n${links}` : ""}`;
}

/** An act result: what ran, where it ended up, and any question browser-box needs answered. */
export function renderBoxAct(r: BoxResult): string {
  const steps = Array.isArray(r.steps) ? (r.steps as Array<Record<string, unknown>>).map((st) => `- ${st.command ?? ""}: ${st.did ?? st.outcome ?? ""}`).join("\n") : "";
  const extra = r.status === "needs_clarification" ? `\nNeeds a pick: ${JSON.stringify(r.options ?? r.question ?? r)}` : "";
  return `${r.status ?? "?"} — ${r.title ?? ""} ${r.url ?? ""}\n${steps}${extra}${r.text_note ? `\n(${r.text_note})` : ""}`;
}
