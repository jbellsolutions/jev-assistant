/** What Jev can actually do, as data — generated from Jev's own source, never written by hand.
 *
 *  The twice-weekly review's whole value is comparing "what's new in the ecosystem" against
 *  "what we already have". A hand-maintained list would drift within a week and the review would
 *  start confidently recommending things Jev already ships, so everything here is read out of the
 *  code that implements it.
 *
 *  Two sources, deliberately kept apart because the difference between them is informative:
 *   - `implemented`  — parsed/imported from source: what exists in the tree.
 *   - `live`         — GET /api/health + /api/sessions on a running companion: what is drivable
 *                      right now. A surface that is implemented but not live ("the bridge isn't
 *                      connected") is a different answer from one that doesn't exist.
 *   - `planned`      — a name declared with no implementation behind it. `orgo` is the founding
 *                      member: it's in the ExecutorKind union and nowhere else. "We have a seam
 *                      for that but nothing behind it" is far more actionable than "we don't have it".
 *
 *  Every collection is asserted non-empty and every executor file must produce a row: a manifest
 *  that silently parsed to nothing would make every candidate look like a gap. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_PAGE_TEXT } from "../../core/elements.js";
import { BRIDGE_PROTOCOL } from "../../core/remote.js";
import { FAST_LANE_THRESHOLD, ROUTES, ROUTE_THRESHOLD } from "../../core/route.js";
import { DEFAULT_MODEL, LIMITS } from "../brain/agent.js";
import { APP_READS, APP_WRITES } from "../brain/apps.js";
import { TOOL_NAMES } from "../brain/tools.js";

/** Kinds still named in ExecutorKind that were removed on purpose — not seams waiting for work.
 *  playwright: v11 replaced the local background browser with browser-box. */
export const RETIRED_KINDS: Record<string, string> = { playwright: "replaced by browser-box in v11" };

export const repoRoot = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface ExecutorRow {
  /** File it lives in, relative to the repo root — the Surveyor cites this as "the nearest thing". */
  file: string;
  id: string;
  kind: string;
  capabilities: Record<string, boolean | string>;
  /** Set when the row is not the whole story (a delegating router, a runtime-mutated capability). */
  note?: string;
}

export interface Manifest {
  generated: string;
  repo: string;
  actions: string[];
  executorKinds: string[];
  executors: ExecutorRow[];
  /** Declared kinds with no executor behind them. */
  planned: string[];
  routes: Array<{ id: string; what: string }>;
  /** The brain's named tools (server/brain/tools.ts), and the model behind it. */
  brainTools: string[];
  brainModel: string;
  /** Composio actions by name: reads run straight away, writes ask the user first. */
  connectors: { reads: string[]; writes: string[] };
  /** What the brain can do in Jev's own browsers (browser-box). */
  browserBox: string[];
  /** The Cua Driver calls Jev's Mac hands make (server/executors/mac.ts). */
  macDriver: string[];
  httpRoutes: string[];
  limits: Record<string, unknown>;
  /** Present only when a companion answered; null when nothing was running. */
  live: LiveSurfaces | null;
}

export interface LiveSurfaces {
  url: string;
  paused: boolean;
  sessions: Array<{ id: string; kind: string; ready?: boolean; capabilities?: Record<string, boolean> }>;
  /** Why the session list is empty, when it is empty for a reason other than "nothing is attached".
   *  An unauthorised probe reporting `sessions: []` reads exactly like a running app with no
   *  surfaces — the review would then call every surface a gap. */
  problem?: string;
}

/** A parse that finds nothing is a bug, not an empty result — see the header. */
function required<T>(what: string, values: T[], min = 1): T[] {
  if (values.length < min) throw new Error(`capability manifest: found ${values.length} ${what} (expected at least ${min}) — the source moved and the parser didn't`);
  return values;
}

const read = (root: string, rel: string) => readFileSync(path.join(root, rel), "utf8");

/** The Action union is a type, so there is no value to import — take the `kind:` of each member. */
export function parseActions(source: string): string[] {
  return required("actions", [...source.matchAll(/\|\s*\{\s*kind:\s*"([a-z_]+)"/g)].map((m) => m[1]!));
}

/** `export type ExecutorKind = "playwright" | "chrome" | ...;` */
export function parseExecutorKinds(source: string): string[] {
  const line = /export type ExecutorKind\s*=([^;]+);/.exec(source);
  if (!line) throw new Error("capability manifest: ExecutorKind declaration not found in core/executor.ts");
  return required("executor kinds", [...line[1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!));
}

/** `readonly capabilities: ExecutorCapabilities = { screenshot: true, ... }` */
function parseCapabilityLiteral(source: string): Record<string, boolean> | null {
  const m = /capabilities:\s*ExecutorCapabilities\s*=\s*\{([^}]*)\}/.exec(source);
  if (!m) return null;
  return Object.fromEntries([...m[1]!.matchAll(/(\w+)\s*:\s*(true|false)/g)].map((c) => [c[1]!, c[2] === "true"]));
}

const idFrom = (source: string, fallback: string) => /readonly id\s*=\s*"([^"]+)"/.exec(source)?.[1] ?? /id\s*=\s*"([^"]+)"\s*,/.exec(source)?.[1] ?? fallback;

export function parseExecutors(root: string): ExecutorRow[] {
  const dir = path.join(root, "server", "executors");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const rows = files.map((f): ExecutorRow => {
    const source = readFileSync(path.join(dir, f), "utf8");
    const file = `server/executors/${f}`;
    const base = f.replace(/\.ts$/, "");
    const literal = parseCapabilityLiteral(source);
    if (!literal) {
      // A getter instead of a literal means it delegates — front.ts is a router over the others,
      // not a fourth surface, and describing it by whichever executor it happens to hold is how a
      // task ends up driving the user's Chrome while calling itself a background browser.
      if (!/get capabilities\(\)/.test(source)) throw new Error(`capability manifest: ${file} has neither a capabilities literal nor a getter`);
      return { file, id: idFrom(source, base), kind: "delegates", capabilities: { screenshot: "delegates", viewport: "delegates", clickAt: "delegates", read: "delegates" }, note: "router: picks whichever surface the user is actually looking at — a long run on it takes over their screen" };
    }
    const caps: Record<string, boolean | string> = { ...literal };
    // remote.ts flips read on at runtime from the bridge handshake; the literal alone would lie.
    const mutated = [...source.matchAll(/this\.capabilities\.(\w+)\s*=\s*([^;]+);/g)];
    for (const [, key, expr] of mutated) caps[key!] = `dynamic: ${expr!.trim()}`;
    const kind = /readonly kind\s*:\s*ExecutorKind\s*=\s*"([a-z]+)"/.exec(source)?.[1] ?? /kind\s*=\s*"([a-z]+)"/.exec(source)?.[1] ?? base;
    return { file, id: idFrom(source, base), kind, capabilities: caps, ...(mutated.length ? { note: `capability set at runtime; BRIDGE_PROTOCOL is ${BRIDGE_PROTOCOL}` } : {}) };
  });
  return required("executors", rows, files.length);
}

/** The browser_box tool's action enum, read from its schema. */
export function parseBrowserBoxActions(source: string): string[] {
  const block = /browser_box:\s*tool\([\s\S]*?action:\s*z\.enum\(\[([^\]]+)\]/.exec(source);
  return required("browser-box actions", block ? [...block[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!) : []);
}

/** Every cua-driver tool the Mac executor calls: `this.call("get_window_state", …)`, `this.input("press_key", …)`. */
export function parseMacDriverCalls(source: string): string[] {
  return required("Mac driver calls", [...new Set([...source.matchAll(/this\.(?:call|input)\(\s*"([a-z_]+)"/g)].map((m) => m[1]!))]);
}

export function parseHttpRoutes(source: string): string[] {
  return required("HTTP routes", [...source.matchAll(/\bapi\.(get|post|put|delete)\(\s*"([^"]+)"/g)].map((m) => `${m[1]!.toUpperCase()} /api${m[2]!}`));
}

/** Ask a running companion what is drivable right now. Never throws: nothing running is a fact
 *  the review reports, not a reason to fail. */
export async function probeLive(baseUrl: string, token: string | undefined, fetchImpl: typeof fetch = fetch): Promise<LiveSurfaces | null> {
  try {
    const health = await fetchImpl(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) return null;
    const h = (await health.json()) as { url?: string; paused?: boolean };
    const res = await fetchImpl(`${baseUrl}/api/sessions`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      const why = res.status === 401 || res.status === 403 ? `couldn't list surfaces: HTTP ${res.status} — ${token ? "JEV_TOKEN is wrong" : "no JEV_TOKEN was supplied"}` : `couldn't list surfaces: HTTP ${res.status}`;
      return { url: h.url ?? baseUrl, paused: !!h.paused, sessions: [], problem: why };
    }
    const body = (await res.json()) as { sessions?: LiveSurfaces["sessions"] };
    return { url: h.url ?? baseUrl, paused: !!h.paused, sessions: body.sessions ?? [] };
  } catch {
    return null;
  }
}

/** The app is normally launched from the Dock with no shell, so it reads its own gitignored .env;
 *  a script run from launchd has the same problem. Take JEV_TOKEN from there when the environment
 *  doesn't already carry one, rather than probing unauthenticated and reporting an empty app. */
export function tokenFromEnvFile(root = repoRoot()): string | undefined {
  if (process.env.JEV_TOKEN?.trim()) return process.env.JEV_TOKEN.trim();
  try {
    return /^\s*JEV_TOKEN\s*=\s*(.+?)\s*$/m.exec(readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.replace(/^["']|["']$/g, "") || undefined;
  } catch {
    return undefined;
  }
}

export interface ManifestOptions {
  root?: string;
  /** Skip the live probe entirely (tests, and any run that must not depend on the app). */
  baseUrl?: string | null;
  token?: string | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
}

export async function buildManifest(opts: ManifestOptions = {}): Promise<Manifest> {
  const root = opts.root ?? repoRoot();
  const executors = parseExecutors(root);
  const executorKinds = parseExecutorKinds(read(root, "core/executor.ts"));
  const implementedKinds = new Set(executors.map((e) => e.kind));
  return {
    generated: (opts.now?.() ?? new Date()).toISOString(),
    repo: root,
    actions: parseActions(read(root, "core/actions.ts")),
    executorKinds,
    executors,
    planned: executorKinds.filter((k) => !implementedKinds.has(k) && !(k in RETIRED_KINDS)),
    routes: Object.entries(ROUTES).map(([id, r]) => ({ id, what: (r as { what: string }).what })),
    brainTools: required("brain tools", [...TOOL_NAMES]),
    brainModel: process.env.JEV_BRAIN_MODEL?.trim() || DEFAULT_MODEL,
    connectors: { reads: required("connector reads", [...APP_READS]), writes: required("connector writes", Object.keys(APP_WRITES)) },
    browserBox: parseBrowserBoxActions(read(root, "server/brain/tools.ts")),
    macDriver: parseMacDriverCalls(read(root, "server/executors/mac.ts")),
    httpRoutes: parseHttpRoutes(read(root, "server/http.ts")),
    limits: { brain: LIMITS, maxPageText: MAX_PAGE_TEXT, bridgeProtocol: BRIDGE_PROTOCOL, routeThreshold: ROUTE_THRESHOLD, fastLaneThreshold: FAST_LANE_THRESHOLD },
    live: opts.baseUrl === null ? null : await probeLive(opts.baseUrl ?? `http://127.0.0.1:${process.env.JEV_APP_PORT ?? 3111}`, opts.token ?? tokenFromEnvFile(root), opts.fetch ?? fetch),
  };
}

/** The manifest as the Surveyor sees it: compact prose, because it goes into a model prompt where
 *  every token of JSON punctuation is a token not spent on the candidate being judged. */
export function describeManifest(m: Manifest): string {
  const cap = (c: Record<string, boolean | string>) =>
    Object.entries(c)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
  return [
    `Jev (the Mac voice/desktop assistant) as of ${m.generated}.`,
    `Shape: instant commands run in a deterministic fast lane (no model); anything else goes to a small in-app brain — the Vercel AI SDK tool loop on ${m.brainModel} via OpenRouter, capped at ${String((m.limits.brain as { maxSteps?: number }).maxSteps)} steps, writes ask the user first. Memory is his Obsidian vault.`,
    `Fast-lane actions: ${m.actions.join(", ")}. Lanes: ${m.routes.map((r) => r.id).join(", ")}.`,
    `Brain tools (named, nothing else): ${m.brainTools.join(", ")}.`,
    `- Mac apps through Cua Driver, in the background by app name (no focus, no mouse): ${m.macDriver.join(", ")}.`,
    `- the user's own Chrome with his logins, in Jev's own minimized window (bridge extension).`,
    `- Jev's own browsers (browser-box: Steel + a gateway; persistent signed-in sessions): ${m.browserBox.join(", ")}.`,
    `- Connectors (Composio, by action name): reads ${m.connectors.reads.join(", ")}; writes (ask first) ${m.connectors.writes.join(", ")}.`,
    `Surfaces:`,
    ...m.executors.map((e) => `  - ${e.id} (${e.kind}, ${e.file}): ${cap(e.capabilities)}${e.note ? ` — ${e.note}` : ""}`),
    m.planned.length ? `Declared but NOT implemented (a seam exists, nothing behind it): ${m.planned.join(", ")}.` : "Nothing declared-but-unimplemented.",
    `Retired on purpose (do not recommend bringing back without a new reason): ${Object.entries(RETIRED_KINDS).map(([k, why]) => `${k} — ${why}`).join("; ")}.`,
    `HTTP API: ${m.httpRoutes.join(", ")}.`,
    m.live ? `Live right now: ${m.live.problem ?? (m.live.sessions.map((s) => `${s.id}(${s.kind}${s.ready === false ? ", not ready" : ""})`).join(", ") || "the app is running with no surfaces attached")}.` : `Not probed live (the Jev app wasn't running).`,
  ].join("\n");
}
