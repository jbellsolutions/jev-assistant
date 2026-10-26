/** A small client for browser-box's local gateway (`/api/v1/<tool>`, bearer `BB_TOKEN`): Jev's own
 *  browsers, separate from the user's Chrome. Public research, pages that need JavaScript, and
 *  sessions he signs into once and Jev reuses. Self-hosted; nothing here is billed. */

export interface BrowserBoxOptions {
  url: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type BoxResult = Record<string, unknown>;

export class BrowserBox {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: BrowserBoxOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  get url(): string {
    return this.opts.url;
  }

  /** One tool call. Errors come back as thrown Errors carrying the gateway's own message. */
  async call(tool: "fetch" | "read" | "act" | "session" | "status", body: Record<string, unknown> | null, signal?: AbortSignal): Promise<BoxResult> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 120_000);
    const res = await this.fetchImpl(`${this.opts.url.replace(/\/$/, "")}/api/v1/${tool}`, {
      method: body === null ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.opts.token}`, ...(body === null ? {} : { "content-type": "application/json" }) },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await res.text();
    let json: BoxResult;
    try {
      json = JSON.parse(text) as BoxResult;
    } catch {
      throw new Error(`browser-box answered HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(String(json.error ?? json.detail ?? `browser-box answered HTTP ${res.status}`));
    return json;
  }
}

export function selectBrowserBox(env: NodeJS.ProcessEnv = process.env): BrowserBox | null {
  const token = env.BB_TOKEN?.trim();
  if (!token) return null;
  return new BrowserBox({ url: env.BB_URL?.trim() || "http://127.0.0.1:8080", token });
}

/** The live, clickable view of Jev's own browser: Steel's session player, which browser-box already
 *  runs. The panel embeds it, so the user can watch the brain work and sign in by hand in the same
 *  browser `browser_box` uses. Loopback only — the player is not meant to leave this Mac. Null when
 *  browser-box isn't set up here. */
export function browserViewUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.BB_TOKEN?.trim()) return null;
  const base = (env.BB_STEEL_URL?.trim() || "http://127.0.0.1:3000").replace(/\/+$/, "");
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    return null;
  }
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) return null;
  return `${base}/v1/sessions/debug?interactive=true&theme=dark`;
}
