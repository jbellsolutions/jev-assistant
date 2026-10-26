/** The co-founder: Hermes Studio's head agent ("default") on the user's always-on Orgo computer.
 *  Jev hands it tasks; it does not replace Jev's brain (the user's choice, 2026-09-25).
 *
 *  The route is Orgo's own API, not SSH: the box's Tailscale SSH is in check mode and wants a
 *  browser re-auth, while Orgo's `/computers/{id}/bash` runs a command there with the API key the user
 *  already has. On the box, a copy of the Studio's documented admin helper (see RPC_PY) reads its
 *  own private token and refuses to run on the wrong computer — so no Studio secret ever leaves
 *  the machine, and Jev never holds one.
 *
 *  Three rules this file exists to keep:
 *  - It never starts or stops that computer. Every call checks it is running first and refuses
 *    otherwise, so a bash call can never be what wakes it.
 *  - the user's words never touch a shell. The message travels base64-encoded inside a fixed
 *    script; nothing the brain (or a page the brain read) says can become a command.
 *  - A retry is not a second task: every hand-off carries a request id, and the Studio answers
 *    a repeated id with the delivery it already has. */
import { randomUUID } from "node:crypto";
import type { CofounderExchange } from "../core/protocol.js";

export const ORGO_API = "https://www.orgo.ai/api";
/** Placeholder for direct API construction in tests; installed users must choose a computer. */
export const COFOUNDER_COMPUTER = "00000000-0000-4000-8000-000000000000";
const PYTHON = "/opt/hermes-orgo-studio/venv/bin/python";
/** Where the live Studio listens on the box, and the token file it reads — both on the box.
 *  Checked live 2026-09-26: the co-founder runs as Supervisor's `unified-studio-runtime`
 *  (`hermes serve` on 8790, token under studio-cloud/). The older `hermes-studio` on 8787 that
 *  docs/studio-operations.md describes is stopped, and 8787 now belongs to another app. */
export const STUDIO_PORT = 8790;
export const STUDIO_TOKEN_FILE = "/root/.hermes/studio-cloud/gateway-token";

/** The Studio's own admin helper (scripts/studio_remote_rpc.py), carried inline because the copy
 *  on the box still points at the stopped service. Same arguments, same guarantees: it runs only
 *  on the computer it was meant for, and reads the Studio's token there — it never leaves. */
const RPC_PY = `import json,sys
from pathlib import Path
from websockets.sync.client import connect
a=sys.argv[1:];cid=a[a.index('--computer-id')+1];method,params=a[-2],json.loads(a[-1])
if json.loads(Path('/root/.hermes/orgo-computer/computer.json').read_text()).get('computerId')!=cid: raise SystemExit('Wrong computer')
tok=Path('${STUDIO_TOKEN_FILE}').read_text().strip()
with connect(f'ws://127.0.0.1:${STUDIO_PORT}/api/ws?token={tok}',max_size=None,additional_headers={'Origin':'http://127.0.0.1:${STUDIO_PORT}'}) as ws:
  ws.send(json.dumps({'jsonrpc':'2.0','id':'jev','method':method,'params':params}))
  while True:
    r=json.loads(ws.recv(timeout=90))
    if r.get('id')=='jev':
      print(json.dumps(r,ensure_ascii=False));sys.exit(1 if 'error' in r else 0)`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQ = /^[0-9a-f]{32}$/;
const B64 = /^[A-Za-z0-9+/=]*$/;
/** States after which a delivery will not change on its own. */
export const DONE_STATES = new Set(["complete", "error", "cancelled", "needs_review"]);
/** How much of a reply comes back through the tool. */
export const REPLY_CHARS = 4000;

/** Runs on the box: reads the Studio's answer from stdin and prints only OUR delivery — the
 *  owner's status is the whole ledger, which must not flow back into Jev's context. Prints (and
 *  exits 0) once the delivery is finished, or with --any; silent exit 3 while it is still going. */
const EXTRACT = `import json,sys
req=sys.argv[1];anyway=len(sys.argv)>2
raw=sys.stdin.read()
lines=[l for l in raw.splitlines() if l.strip()]
try: r=json.loads(lines[-1]) if lines else {}
except Exception: print(json.dumps({'id':req,'state':'rpc_error','result':raw[-300:]}));sys.exit(0)
if 'error' in r: print(json.dumps({'id':req,'state':'rpc_error','result':str(r['error'].get('message',''))[:500]}));sys.exit(0)
res=r.get('result') or {}
d=res if res.get('id')==req else next((x for x in res.get('deliveries') or [] if x.get('id')==req),None)
done=d is not None and d.get('state') in ${JSON.stringify([...DONE_STATES]).replace(/"/g, "'")}
if not (done or anyway): sys.exit(3)
print(json.dumps({'id':req,'state':d.get('state') if d else 'unknown','result':str((d or {}).get('result') or '')[:${REPLY_CHARS}]}))`;

export interface Delivery {
  id: string;
  state: string;
  result: string;
}

/** One exchange in the Studio, as the panel's co-founder chat and the collision check see it. */
export type Exchange = CofounderExchange;

/** Runs on the box: the owner's `status` is the whole ledger; print only the latest few, clipped. */
const LIST = `import json,sys
n=int(sys.argv[1]);raw=sys.stdin.read()
lines=[l for l in raw.splitlines() if l.strip()]
try: r=json.loads(lines[-1]) if lines else {}
except Exception: print(json.dumps({'error':raw[-300:]}));sys.exit(0)
if 'error' in r: print(json.dumps({'error':str(r['error'].get('message',''))[:500]}));sys.exit(0)
ds=sorted((r.get('result') or {}).get('deliveries') or [],key=lambda d:d.get('created') or 0,reverse=True)[:n]
print(json.dumps({'deliveries':[{'id':str(d.get('id') or ''),'sender':str(d.get('sender') or ''),'recipient':str(d.get('recipient') or ''),'state':str(d.get('state') or ''),'body':str(d.get('body') or '')[:1500],'result':str(d.get('result') or '')[:3000],'created':d.get('created') or 0} for d in ds]}))`;

/** The script that lists the latest `limit` exchanges. Nothing but a number is substituted in. */
export function listScript(opts: { computerId: string; limit: number; py?: string }): string {
  const PY = opts.py ?? PYTHON;
  if (!UUID.test(opts.computerId)) throw new Error("bad computer id");
  const n = Math.max(1, Math.min(50, Math.floor(opts.limit)));
  return [
    "set -e",
    `X=$(printf %s '${Buffer.from(LIST).toString("base64")}' | base64 -d)`,
    `R=$(printf %s '${Buffer.from(RPC_PY).toString("base64")}' | base64 -d)`,
    `${PY} -c "$R" --computer-id ${opts.computerId} studio.operation '{"operation":"status"}' 2>&1 | ${PY} -c "$X" ${n}`,
  ].join("\n");
}

/** The whole script sent to the box. Only validated ids and base64 are substituted in. */
export function studioScript(opts: { computerId: string; requestId: string; sendB64?: string; rounds: number; waitSeconds: number; py?: string; rpc?: string }): string {
  const { computerId: cid, requestId: req, sendB64, rounds, waitSeconds } = opts;
  const PY = opts.py ?? PYTHON;
  const RPC = opts.rpc ?? '-c "$R"';
  if (!UUID.test(cid)) throw new Error("bad computer id");
  if (!REQ.test(req)) throw new Error("bad request id");
  if (sendB64 !== undefined && !B64.test(sendB64)) throw new Error("bad payload");
  const n = Math.max(0, Math.min(4, Math.floor(rounds)));
  const wait = Math.max(0, Math.min(30, Math.floor(waitSeconds)));
  const call = (params: string) => `${PY} ${RPC} --computer-id ${cid} studio.operation ${params}`;
  const extract = `${PY} -c "$X" ${req}`;
  return [
    "set -e",
    `X=$(printf %s '${Buffer.from(EXTRACT).toString("base64")}' | base64 -d)`,
    ...(opts.rpc ? [] : [`R=$(printf %s '${Buffer.from(RPC_PY).toString("base64")}' | base64 -d)`]),
    // A refused send is reported through the same filter, so the reason comes back rather than nothing.
    ...(sendB64 !== undefined ? [`P=$(printf %s '${sendB64}' | base64 -d)`, `S=$(${call('"$P"')} 2>&1) || { printf '%s\n' "$S" | ${extract} --any; exit 0; }`] : []),
    `for i in $(seq 1 ${n}); do`,
    `  if ${call(`'{"operation":"wait","seconds":${wait}}'`)} 2>&1 | ${extract}; then exit 0; fi`,
    "done",
    `${call(`'{"operation":"status"}'`)} 2>&1 | ${extract} --any`,
  ].join("\n");
}

export interface CofounderOptions {
  apiKey: string;
  computerId?: string;
  fetch?: typeof fetch;
}

export class Cofounder {
  readonly computerId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly lateListeners = new Set<(d: Delivery, message: string) => void>();

  constructor(private readonly opts: CofounderOptions) {
    this.computerId = opts.computerId ?? COFOUNDER_COMPUTER;
    if (!UUID.test(this.computerId)) throw new Error(`JEV_COFOUNDER_COMPUTER is not a computer id: ${this.computerId}`);
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async api(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${ORGO_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Orgo answered HTTP ${res.status}${res.status === 401 ? " — the ORGO_API_KEY was refused" : ""}`);
    return ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  }

  /** The computer's own state. Read-only. */
  async status(): Promise<string> {
    const r = await this.api("GET", `/computers/${this.computerId}`);
    return String(r.status ?? "unknown");
  }

  /** Refuses unless the computer is already running: nothing here may be what starts it. */
  private async requireRunning(): Promise<void> {
    const s = await this.status();
    if (s !== "running") throw new Error(`The co-founder's computer is ${s}. I won't start it — that's yours to do in Orgo.`);
  }

  private async bash(script: string, timeoutSeconds: number): Promise<Delivery> {
    await this.requireRunning();
    const r = await this.api("POST", `/computers/${this.computerId}/bash`, { command: script, timeout: timeoutSeconds }, (timeoutSeconds + 20) * 1000);
    const out = String(r.output ?? r.stdout ?? r.result ?? "").trim();
    const last = out.split("\n").filter(Boolean).at(-1) ?? "";
    let d: Delivery | null = null;
    try {
      d = JSON.parse(last) as Delivery;
    } catch {
      /* explained below */
    }
    const why = d?.state === "rpc_error" ? d.result : d ? "" : out;
    if (d && !why) return d;
    if (/PermissionError|Permission denied/.test(why)) throw new Error("Orgo's shell on the co-founder's computer can't read the Studio's files (it isn't running as root), so Jev can't reach the co-founder this way.");
    if (/Wrong computer/.test(why)) throw new Error("The Studio on that computer says it is bound to a different computer id — check JEV_COFOUNDER_COMPUTER.");
    if (d) throw new Error(`The Studio refused: ${why.slice(-300)}`);
    throw new Error(`The co-founder's computer answered, but not with the Studio's reply${out ? `: ${out.slice(-300)}` : ""}`);
  }

  /** The latest exchanges in the Studio, newest first. Read-only. */
  async deliveries(limit = 10): Promise<Exchange[]> {
    await this.requireRunning();
    const r = await this.api("POST", `/computers/${this.computerId}/bash`, { command: listScript({ computerId: this.computerId, limit }), timeout: 40 }, 60_000);
    const out = String(r.output ?? r.stdout ?? r.result ?? "").trim();
    const last = out.split("\n").filter(Boolean).at(-1) ?? "";
    const parsed = ((): { deliveries?: Exchange[]; error?: string } | null => {
      try {
        return JSON.parse(last) as { deliveries?: Exchange[]; error?: string };
      } catch {
        return null; // explained below
      }
    })();
    if (parsed?.deliveries) return parsed.deliveries;
    if (/PermissionError|Permission denied/.test(out)) throw new Error("Orgo's shell on the co-founder's computer can't read the Studio's files, so Jev can't see its conversation this way.");
    throw new Error(`The Studio didn't list its conversation${parsed?.error ? `: ${parsed.error}` : out ? `: ${out.slice(-300)}` : ""}`);
  }

  /** Is the co-founder in the middle of something? (A delivery that hasn't finished.) */
  async busy(): Promise<Exchange | null> {
    return (await this.deliveries(10)).find((d) => !DONE_STATES.has(d.state)) ?? null;
  }

  /** Hand a task to the head agent and wait a little for the reply. `requestId` makes a retry of
   *  the same hand-off return the same delivery instead of starting a second task. */
  async send(message: string, requestId = newRequestId(), opts: { rounds?: number; waitSeconds?: number } = {}): Promise<Delivery> {
    const params = { operation: "send", recipient: "default", message, request_id: requestId };
    const script = studioScript({ computerId: this.computerId, requestId, sendB64: Buffer.from(JSON.stringify(params)).toString("base64"), rounds: opts.rounds ?? 2, waitSeconds: opts.waitSeconds ?? 25 });
    return this.bash(script, 90);
  }

  /** Where a hand-off stands now, without waiting. */
  async check(requestId: string): Promise<Delivery> {
    return this.bash(studioScript({ computerId: this.computerId, requestId, rounds: 0, waitSeconds: 0 }), 45);
  }

  /** The live desktop, for the panel: the noVNC socket address and the password it needs. The
   *  password changes on every restart of the computer, so it is fetched each time and never kept,
   *  logged or written anywhere — it goes to the one panel socket that asked. */
  async view(): Promise<{ wsUrl: string; password: string }> {
    await this.requireRunning();
    const info = await this.api("GET", `/computers/${this.computerId}`);
    const wsUrl = vncSocketUrl(String(info.connection_url ?? info.url ?? ""));
    const r = await this.api("GET", `/computers/${this.computerId}/vnc-password`);
    const password = String(r.password ?? r.vnc_password ?? "");
    if (!password) throw new Error("Orgo gave no VNC password for the co-founder's computer.");
    return { wsUrl: `${wsUrl}?token=${encodeURIComponent(password)}`, password };
  }

  /** A still picture of the desktop: the fallback when the live view can't connect. */
  async screenshot(): Promise<{ jpegBase64: string } | null> {
    await this.requireRunning();
    const res = await this.fetchImpl(`${ORGO_API}/computers/${this.computerId}/screenshot?response_format=base64&format=jpeg&quality=70`, {
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Orgo answered HTTP ${res.status}`);
    const r = (await res.json().catch(() => ({}))) as { image?: string };
    return r.image ? { jpegBase64: r.image } : null;
  }

  /** A reply that arrived after the tool call had returned. */
  onLate(fn: (d: Delivery, message: string) => void): () => void {
    this.lateListeners.add(fn);
    return () => this.lateListeners.delete(fn);
  }

  /** Keep checking a hand-off in the background and report it when it finishes. Bounded: it
   *  gives up after `maxMs` and says so, rather than polling forever. */
  watch(requestId: string, message: string, opts: { everyMs?: number; maxMs?: number; schedule?: (fn: () => void, ms: number) => void } = {}): void {
    const every = opts.everyMs ?? 45_000;
    const deadline = Date.now() + (opts.maxMs ?? 30 * 60_000);
    const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms).unref?.());
    const tick = async () => {
      let d: Delivery | null = null;
      try {
        d = await this.check(requestId);
      } catch {
        /* a failed check is retried at the next tick */
      }
      if (d && DONE_STATES.has(d.state)) {
        for (const fn of this.lateListeners) fn(d, message);
        return;
      }
      if (Date.now() >= deadline) {
        for (const fn of this.lateListeners) fn({ id: requestId, state: "gave_up", result: "" }, message);
        return;
      }
      schedule(() => void tick(), every);
    };
    schedule(() => void tick(), every);
  }
}

/** Orgo's desktop address → its noVNC socket. Only Orgo's own https desktop paths are accepted, so
 *  a surprising answer can't point the panel's password at some other host. */
export function vncSocketUrl(connectionUrl: string): string {
  let base: URL;
  try {
    base = new URL(connectionUrl);
  } catch {
    throw new Error("Orgo gave no desktop address for the co-founder's computer.");
  }
  if (base.protocol !== "https:" || !/^\/desktops\/[A-Za-z0-9_-]+\/?$/.test(base.pathname)) throw new Error("Orgo's desktop address for the co-founder's computer looks wrong; not connecting.");
  return `wss://${base.host}${base.pathname.replace(/\/$/, "")}/ws/websockify`;
}

export function newRequestId(): string {
  return randomUUID().replace(/-/g, "");
}

/** Configured from the environment; null without an Orgo key. */
export function selectCofounder(env: NodeJS.ProcessEnv = process.env): Cofounder | null {
  const apiKey = env.ORGO_API_KEY?.trim();
  if (!apiKey || !env.JEV_COFOUNDER_COMPUTER?.trim()) return null;
  return new Cofounder({ apiKey, computerId: env.JEV_COFOUNDER_COMPUTER?.trim() || COFOUNDER_COMPUTER });
}

/** Where a late reply goes: a log entry in the panel, said aloud unless muted. One line, so both
 *  entry points (app/main.ts, server/index.ts) say the same thing. */
export function wireCofounder(cofounder: Cofounder | null, announce: (from: string, text: string, level?: "ok" | "warn", spoken?: string) => void, log: (line: string) => void = () => {}): void {
  if (!cofounder) {
    log("co-founder: off (set ORGO_API_KEY)");
    return;
  }
  log(`co-founder: Orgo computer ${cofounder.computerId}`);
  cofounder.onLate((d, message) => {
    const task = message.length > 80 ? `${message.slice(0, 80)}…` : message;
    if (d.state === "complete") announce("↩ The co-founder replied", d.result || "(an empty reply)", "ok", `The co-founder replied. ${d.result}`);
    else if (d.state === "gave_up") announce("↩ The co-founder", `Still no reply to "${task}" after 30 minutes — I stopped checking. It may still be working; look in the Studio app.`, "warn");
    else if (d.state === "needs_review") announce("↩ The co-founder", `"${task}" is held for your review in the Studio app (the Studio restarted mid-task).`, "warn");
    else announce("↩ The co-founder", `"${task}" ended ${d.state}${d.result ? `: ${d.result}` : ""}`, "warn");
  });
}
