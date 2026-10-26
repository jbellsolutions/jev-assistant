/** JSON API for programmatic callers (scripts, smoke tests). Every route except /api/health requires
 *  the bearer token. Nothing here ever reaches the brain: /command is local-only. */
import { type Response, Router, json } from "express";
import type { Decider } from "../core/decide.js";
import { MAX_PAGE_TEXT } from "../core/elements.js";
import type { Session } from "../core/session.js";
import type { Auth } from "./auth.js";
import type { Hub } from "./hub.js";

export interface ApiDeps {
  hub: Hub;
  auth: Auth;
  decider: Decider;
}

export function createApi({ hub, auth, decider }: ApiDeps): Router {
  const api = Router();
  api.use(json({ limit: "64kb" }));

  api.get("/health", async (_req, res) => {
    const def = hub.defaultId;
    const session = def ? hub.get(def) : undefined;
    res.json({ ok: true, paused: hub.paused, jev: { enabled: decider.enabled, model: decider.model }, url: session?.executor.url ?? null, sessions: (await hub.statuses()).map((s) => s.id) });
  });

  // The Chrome bridge asks this before opening its socket: Chrome logs every refused or 403'd
  // WebSocket as an error on chrome://extensions, and a quiet 200 here logs nothing.
  api.get("/bridge-ready", (req, res) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "");
    res.json({ ok: true, token: !auth.configured ? "unset" : m && auth.check(m[1]) ? "ok" : "wrong" });
  });

  api.use(auth.bearer);

  const resolve = (res: Response, id: unknown): Session | null => {
    const wanted = typeof id === "string" && id ? id : hub.defaultId;
    const session = wanted ? hub.get(wanted) : undefined;
    if (!session) {
      res.status(404).json({ error: wanted ? `no session "${wanted}"` : "no session available" });
      return null;
    }
    return session;
  };

  api.get("/sessions", async (_req, res) => {
    res.json({ default: hub.defaultId, paused: hub.paused, sessions: await hub.statuses() });
  });

  /** Browser/Mac only: a command here never reaches the brain. */
  const PAUSED = "Jev is paused: the user switched the assistant off. Nothing runs on this Mac until they resume it.";
  const paused = (res: Response): boolean => {
    if (!hub.paused) return false;
    res.status(409).json({ error: PAUSED });
    return true;
  };

  api.post("/command", async (req, res) => {
    const { text, session: id } = (req.body ?? {}) as { text?: unknown; session?: unknown };
    if (typeof text !== "string" || !text.trim()) return void res.status(400).json({ error: "text is required" });
    if (paused(res)) return;
    const session = resolve(res, id);
    if (!session) return;
    res.json(await session.command(text, { local: true }));
  });

  /** The page's readable prose. Deliberately its own route: page text is far too big to ride
   *  along on every CommandResult, so callers ask for it only when they actually need it. */
  api.post("/read", async (req, res) => {
    const { session: id, max } = (req.body ?? {}) as { session?: unknown; max?: unknown };
    if (paused(res)) return;
    const session = resolve(res, id);
    if (!session) return;
    const executor = session.executor;
    if (!executor.capabilities.read || !executor.read) {
      return void res.status(422).json({ error: executor.readHint ?? `the ${executor.kind} surface cannot read page text` });
    }
    const cap = typeof max === "number" && Number.isFinite(max) ? Math.max(1, Math.min(MAX_PAGE_TEXT, Math.floor(max))) : undefined;
    try {
      res.json(await executor.read(cap));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  api.post("/pause", (req, res) => {
    hub.setPaused(!!(req.body ?? {}).paused);
    res.json({ ok: true, paused: hub.paused });
  });

  api.post("/reply", async (req, res) => {
    const { ok, pick, session: id } = (req.body ?? {}) as { ok?: unknown; pick?: unknown; session?: unknown };
    const session = resolve(res, id);
    if (!session) return;
    if (typeof pick === "string") return void res.json(await session.pick(pick));
    if (typeof ok === "boolean") return void res.json(await session.reply(ok));
    res.status(400).json({ error: "pass ok: boolean or pick: elementId" });
  });

  api.post("/approve", async (req, res) => {
    const { choice, session: id } = (req.body ?? {}) as { choice?: unknown; session?: unknown };
    const session = resolve(res, id);
    if (!session) return;
    if (choice !== "once" && choice !== "session" && choice !== "always" && choice !== "deny") return void res.status(400).json({ error: "choice must be once | session | always | deny" });
    res.json(await session.approve(choice));
  });

  api.post("/cancel", (req, res) => {
    const session = resolve(res, (req.body ?? {}).session);
    if (!session) return;
    session.cancel();
    res.json({ ok: true });
  });

  return api;
}
