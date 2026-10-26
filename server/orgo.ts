/** Jev's own hands on the co-founder's Orgo computer: look at the screen, click, type, press keys,
 *  scroll, run a command. the user's ask (2026-09-26): "Go to the co-founder's computer and do
 *  something" should be done by Jev directly, without asking the co-founder to do it.
 *
 *  Same rules as `Cofounder` (server/cofounder.ts): Orgo's own API with the user's key; it never
 *  starts or stops the computer — every action first checks it is running and refuses otherwise.
 *  Orgo's paid agent (/v1/chat/completions) is never used: Jev reads the screenshots itself.
 *
 *  Request shapes are browser-box's working client (gateway/gateway/orgo.py). The screen is
 *  1280×720; coordinates are in those pixels. */
import { COFOUNDER_COMPUTER, ORGO_API } from "./cofounder.js";

export const ORGO_SCREEN = { width: 1280, height: 720 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** How long a "running" answer is trusted, so a burst of clicks isn't a status call each. */
const RUNNING_TTL_MS = 60_000;
export const ORGO_BASH_OUTPUT = 8_000;

export interface OrgoOptions {
  apiKey: string;
  computerId?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface OrgoShot {
  jpegBase64: string;
  width: number;
  height: number;
}

export class OrgoComputer {
  readonly computerId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private runningUntil = 0;

  constructor(private readonly opts: OrgoOptions) {
    this.computerId = opts.computerId ?? COFOUNDER_COMPUTER;
    if (!UUID.test(this.computerId)) throw new Error(`not an Orgo computer id: ${this.computerId}`);
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private async api(method: string, path: string, body?: unknown, timeoutMs = 20_000, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${ORGO_API}/computers/${this.computerId}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Orgo answered HTTP ${res.status}${res.status === 401 ? " — the ORGO_API_KEY was refused" : detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    return ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  }

  /** Refuses unless the computer is already running: nothing here may be what starts it. */
  private async requireRunning(signal?: AbortSignal): Promise<void> {
    if (this.now() < this.runningUntil) return;
    const r = await this.api("GET", "", undefined, 20_000, signal);
    const s = String(r.status ?? "unknown");
    if (s !== "running") throw new Error(`The co-founder's computer is ${s}. I won't start it — that's the user's to do in Orgo.`);
    this.runningUntil = this.now() + RUNNING_TTL_MS;
  }

  async screenshot(signal?: AbortSignal): Promise<OrgoShot> {
    await this.requireRunning(signal);
    const r = await this.api("GET", "/screenshot?response_format=base64&format=jpeg&quality=70", undefined, 20_000, signal);
    const image = typeof r.image === "string" ? r.image : "";
    if (!image) throw new Error("Orgo returned no screenshot.");
    return { jpegBase64: image, width: Number(r.width) || ORGO_SCREEN.width, height: Number(r.height) || ORGO_SCREEN.height };
  }

  async click(x: number, y: number, opts: { button?: "left" | "right"; double?: boolean } = {}, signal?: AbortSignal): Promise<void> {
    await this.requireRunning(signal);
    await this.api("POST", "/click", { x: onScreen(x, "x"), y: onScreen(y, "y"), button: opts.button ?? "left", double: !!opts.double }, 20_000, signal);
  }

  async type(text: string, signal?: AbortSignal): Promise<void> {
    await this.requireRunning(signal);
    await this.api("POST", "/type", { text }, 30_000, signal);
  }

  async key(key: string, signal?: AbortSignal): Promise<void> {
    await this.requireRunning(signal);
    await this.api("POST", "/key", { key }, 20_000, signal);
  }

  /** x and y are required by Orgo: without them the pointer warps to the top-left corner. */
  async scroll(x: number, y: number, direction: "up" | "down" | "left" | "right", amount = 3, signal?: AbortSignal): Promise<void> {
    await this.requireRunning(signal);
    await this.api("POST", "/scroll", { x: onScreen(x, "x"), y: onScreen(y, "y"), direction, amount: Math.max(1, Math.min(20, Math.round(amount))) }, 20_000, signal);
  }

  async bash(command: string, timeoutSeconds = 60, signal?: AbortSignal): Promise<string> {
    await this.requireRunning(signal);
    const r = await this.api("POST", "/bash", { command, timeout: timeoutSeconds }, (timeoutSeconds + 15) * 1000, signal);
    const out = String(r.output ?? r.stdout ?? r.result ?? "").trim();
    const code = r.exit_code ?? r.exitCode ?? r.returncode;
    const clipped = out.length > ORGO_BASH_OUTPUT ? `${out.slice(0, ORGO_BASH_OUTPUT)}\n… (${out.length - ORGO_BASH_OUTPUT} more characters)` : out;
    return `${code !== undefined && code !== null && Number(code) !== 0 ? `exit ${code}\n` : ""}${clipped || "(no output)"}`;
  }
}

function onScreen(v: number, axis: "x" | "y"): number {
  const max = axis === "x" ? ORGO_SCREEN.width : ORGO_SCREEN.height;
  const n = Math.round(v);
  if (!Number.isFinite(n) || n < 0 || n >= max) throw new Error(`${axis}=${v} is off the screen (it is ${ORGO_SCREEN.width}×${ORGO_SCREEN.height}).`);
  return n;
}

/** Configured from the environment; null without an Orgo key. */
export function selectOrgo(env: NodeJS.ProcessEnv = process.env): OrgoComputer | null {
  const apiKey = env.ORGO_API_KEY?.trim();
  if (!apiKey || !env.JEV_COFOUNDER_COMPUTER?.trim()) return null;
  return new OrgoComputer({ apiKey, computerId: env.JEV_COFOUNDER_COMPUTER?.trim() || COFOUNDER_COMPUTER });
}
