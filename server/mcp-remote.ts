/** The co-founder's way in: a small MCP server so Hermes on the Orgo computer can use Jev — and so
 *  the user's Mac — as a tool. the user's ask (2026-09-26): "…it has access to Jev, which has access to
 *  my computer… true copilot." His choices: private over Tailscale; the co-founder's actions follow
 *  the same rules as Jev's own.
 *
 *  Four locks, every one of them checked on every request:
 *  - It listens ONLY on this Mac's Tailscale address (100.64.0.0/10), never on 0.0.0.0 — the LAN
 *    and the internet can't reach it at all. No tailnet address, no listener.
 *  - The caller's own address must be on the tailnet too (403 otherwise).
 *  - A bearer token of its own, JEV_COFOUNDER_TOKEN — not JEV_TOKEN, so it can be revoked alone.
 *  - Everything it asks for runs through Jev's own brain and approvals (Session.fromCofounder): a
 *    send, post, delete or unlisted command is asked of the user in his panel, and said aloud.
 *
 *  Stateless Streamable HTTP: a fresh MCP server per request, nothing held between them. */
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { networkInterfaces } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export const COFOUNDER_MCP_PORT = 3112;
/** How long jev_do waits before answering "still working" (the MCP call must not hang for minutes). */
export const JEV_DO_WAIT_MS = 60_000;
const MAX_BODY = 256 * 1024;

/** 100.64.0.0/10 — Tailscale's (CGNAT) range. Accepts the IPv4-mapped IPv6 form a socket reports. */
export function isTailnet(address: string | undefined): boolean {
  const a = (address ?? "").replace(/^::ffff:/, "");
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/** This Mac's own tailnet address, from its network interfaces; null when Tailscale is down. */
export function tailnetAddress(interfaces = networkInterfaces()): string | null {
  for (const list of Object.values(interfaces)) for (const a of list ?? []) if (a.family === "IPv4" && isTailnet(a.address)) return a.address;
  return null;
}

function tokenOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]!.trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface CofounderMcpOptions {
  host: string;
  port?: number;
  token: string;
  /** Run a task through Jev (Session.fromCofounder). */
  doTask: (task: string) => Promise<{ ok: boolean; output: string }>;
  /** What is on the user's screen: the front window, as text. */
  look: () => Promise<string>;
  /** Jev is paused: nothing runs. */
  paused?: () => boolean;
  /** A task that outlived the wait finished: tell the user's panel. */
  onLate?: (task: string, output: string) => void;
  waitMs?: number;
  log?: (line: string) => void;
}

export interface CofounderMcp {
  url: string;
  close(): Promise<void>;
}

/** The request handler on its own: every lock except the bind address. `allowed` is the caller
 *  check — the tailnet range, always, outside tests. */
export function cofounderMcpHandler(opts: Omit<CofounderMcpOptions, "host" | "port">, allowed: (address: string | undefined) => boolean = isTailnet): http.RequestListener {
  if (opts.token.length < 24) throw new Error("JEV_COFOUNDER_TOKEN is too short");
  const waitMs = opts.waitMs ?? JEV_DO_WAIT_MS;
  // Results of tasks that outlived the wait, for jev_result. Bounded; oldest dropped.
  const late = new Map<string, { task: string; output: string | null }>();
  let seq = 0;

  const build = () => {
    const server = new McpServer({ name: "jev", version: "11.4.0" });
    server.registerTool(
      "jev_do",
      {
        description:
          "Ask Jev — the user's assistant on his Mac — to do something on his Mac: his apps, his signed-in Chrome, his files. Jev works in the background. Anything that sends, posts, deletes or runs a non-read-only command is asked of the user first, in his panel; if he says no, it isn't done. Returns Jev's answer, or a job id if it takes over a minute (then call jev_result).",
        inputSchema: { task: z.string().min(1).max(4000).describe("What Jev should do, written as you'd ask a person") },
      },
      async ({ task }) => {
        if (opts.paused?.()) return text("Jev is paused — the user switched it off. Nothing runs on his Mac until he resumes it.");
        opts.log?.(`co-founder → jev_do: ${task.slice(0, 120)}`);
        const job = opts.doTask(task);
        const timer = new Promise<null>((r) => setTimeout(() => r(null), waitMs).unref?.());
        const r = await Promise.race([job, timer]);
        if (r) return text(r.output || (r.ok ? "Done." : "Jev couldn't do that."));
        const id = `job_${(++seq).toString(36)}_${Date.now().toString(36)}`;
        late.set(id, { task, output: null });
        while (late.size > 50) late.delete(late.keys().next().value!);
        void job.then(
          (done) => {
            late.set(id, { task, output: done.output });
            opts.onLate?.(task, done.output);
          },
          (err: unknown) => late.set(id, { task, output: `Failed: ${err instanceof Error ? err.message : String(err)}` }),
        );
        return text(`Jev is still working on it (job ${id}). Call jev_result with that id in a minute or two.`);
      },
    );
    server.registerTool(
      "jev_result",
      { description: "The answer to a jev_do job that took longer than a minute.", inputSchema: { id: z.string() } },
      async ({ id }) => {
        const j = late.get(id);
        if (!j) return text("No such job (or it's too old).");
        return text(j.output ?? "Still working.");
      },
    );
    server.registerTool(
      "jev_look",
      { description: "What is on the user's screen right now: the window in front, as text (buttons, fields, and the text on screen). Read-only.", inputSchema: {} },
      async () => {
        if (opts.paused?.()) return text("Jev is paused — the user switched it off.");
        try {
          return text(await opts.look());
        } catch (err) {
          return text(`Couldn't read the screen: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    );
    return server;
  };

  return async (req, res) => {
    const deny = (code: number, message: string) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    };
    if (!allowed(req.socket.remoteAddress)) return deny(403, "tailnet only");
    if ((req.url ?? "").split("?")[0] !== "/mcp") return deny(404, "not found");
    if (!tokenOk(req.headers.authorization, opts.token)) return deny(401, "bad token");
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_BODY) return deny(413, "too large");
        chunks.push(c as Buffer);
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return deny(400, "bad json");
      }
    }
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) deny(500, err instanceof Error ? err.message : String(err));
    }
  };
}

export async function startCofounderMcp(opts: CofounderMcpOptions): Promise<CofounderMcp> {
  if (!isTailnet(opts.host)) throw new Error(`not a tailnet address: ${opts.host}`);
  const httpServer = http.createServer(cofounderMcpHandler(opts));
  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port ?? COFOUNDER_MCP_PORT, opts.host, () => resolve((httpServer.address() as { port: number }).port));
  });
  return {
    url: `http://${opts.host}:${port}/mcp`,
    close: () => new Promise<void>((r) => httpServer.close(() => r())),
  };
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

/** Start the co-founder's way in, if it can be: needs JEV_COFOUNDER_TOKEN and a tailnet address.
 *  Says why not otherwise — and never falls back to a wider listener. One place, so both entry
 *  points (app/main.ts, server/index.ts) behave the same. */
export async function startCofounderAccess(o: {
  env: NodeJS.ProcessEnv;
  session: () => { fromCofounder(task: string): Promise<{ ok: boolean; output: string }> } | null;
  look: () => Promise<string>;
  paused: () => boolean;
  announce: (from: string, text: string, level?: "ok" | "warn") => void;
  log: (line: string) => void;
}): Promise<CofounderMcp | null> {
  const token = o.env.JEV_COFOUNDER_TOKEN?.trim();
  if (!token) {
    o.log("co-founder access: off (no JEV_COFOUNDER_TOKEN)");
    return null;
  }
  const host = tailnetAddress();
  if (!host) {
    o.log("co-founder access: off (Tailscale isn't connected — no 100.64/10 address)");
    return null;
  }
  try {
    const mcp = await startCofounderMcp({
      host,
      port: Number(o.env.JEV_COFOUNDER_MCP_PORT) || COFOUNDER_MCP_PORT,
      token,
      doTask: async (task) => {
        const s = o.session();
        if (!s) return { ok: false, output: "Jev has no session to work in right now." };
        const r = await s.fromCofounder(task);
        return { ok: r.ok, output: r.output };
      },
      look: o.look,
      paused: o.paused,
      onLate: (task, output) => o.announce("🤝 Done for the co-founder", `"${task.slice(0, 80)}${task.length > 80 ? "…" : ""}" — ${output}`),
      log: o.log,
    });
    o.log(`co-founder access: ${mcp.url} (tailnet only)`);
    return mcp;
  } catch (err) {
    o.log(`co-founder access: off (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}
