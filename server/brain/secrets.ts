/** Keys and passwords a job comes across, kept out of every model's context.
 *
 *  Salesforce shows a new app's consumer key and secret as plain page text, not in a password field,
 *  so the first read of that page would hand both to the worker model and to OpenRouter, into the run
 *  log and the chat. Instead every tool result goes through `mask()` before anything sees it: a value
 *  that looks like a secret becomes a handle, `{{secret:s3 …4f2a}}`, and the raw value stays here, in
 *  memory, for the life of the task. The worker types a secret by writing its handle; `reveal()`
 *  swaps the value in at the last moment, inside the executor call.
 *
 *  Nothing here is written to disk. If Jev quits mid-task, the secrets have to be captured again. */

const HANDLE = /\{\{secret:([A-Za-z0-9_-]+)[^}]*\}\}/g;

/** "Consumer Key", "Client Secret", "API key", "password" — followed by the value itself. */
const LABELLED =
  /\b(consumer\s+key|consumer\s+secret|client\s+secret|client\s+id|api[\s_-]?key|secret(?:\s+key)?|access[\s_-]?token|refresh[\s_-]?token|auth[\s_-]?token|bearer|password|private\s+key)(\s*[:=]?\s*["']?)([^\s"'<>{}]{12,})/gi;

/** A long run of key-like characters. Judged by `looksSecret` before it is masked. */
const TOKEN = /[A-Za-z0-9+/=_\-.~]{24,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GIT_SHA = /^[0-9a-f]{40}$/;
/** A hostname (example-tenant-123.my.salesforce.com): an address, never a secret. */
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}\.?$/;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** Random-looking, not a path, a slug, a UUID or a commit id. */
export function looksSecret(token: string): boolean {
  if (UUID.test(token) || GIT_SHA.test(token) || HOSTNAME.test(token)) return false;
  if ((token.match(/\//g) ?? []).length >= 2) return false; // a path
  if (!/\d/.test(token)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[+/=_\-.~]/].filter((r) => r.test(token)).length;
  if (classes < 2) return false;
  if (token.length < 32 && !(/[a-z]/.test(token) && /[A-Z]/.test(token))) return false;
  return entropy(token) >= 3.5;
}

export class SecretVault {
  private readonly values = new Map<string, string>(); // handle id -> raw value
  private readonly byValue = new Map<string, string>(); // raw value -> handle id
  private n = 0;

  get size(): number {
    return this.values.size;
  }

  /** The text with every secret-looking value replaced by its handle. */
  mask(text: string): string {
    if (!text) return text;
    let out = text;
    // values already held, wherever they turn up again (a shell echo, a field read back)
    for (const [value, id] of [...this.byValue].sort((a, b) => b[0].length - a[0].length)) out = out.split(value).join(this.handle(id));
    out = out.replace(LABELLED, (all, label: string, gap: string, value: string) => {
      if (value.startsWith("{{secret:") || !/\d/.test(value)) return all;
      return `${label}${gap}${this.handle(this.keep(value))}`;
    });
    out = out.replace(TOKEN, (token: string, offset: number, whole: string) => {
      const before = whole.slice(Math.max(0, offset - 3), offset);
      if (before.endsWith("://") || /[/@]$/.test(before)) return token; // inside a URL or an address
      if (/^\{\{secret:/.test(whole.slice(Math.max(0, offset - 9), offset + 1))) return token;
      return looksSecret(token) ? this.handle(this.keep(token)) : token;
    });
    return out;
  }

  /** Give a handle a name the worker (and the next job) can use: {{secret:sf_consumer_key}}. */
  name(handle: string, name: string): string {
    const id = handle.replace(HANDLE, "$1").replace(/^\{\{secret:|\}\}$/g, "").trim().split(/\s/)[0]!;
    const value = this.values.get(id);
    if (!value) return `No secret ${id} — ${this.values.size ? `held: ${this.list()}` : "none captured yet"}.`;
    const clean = name.trim().replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60);
    if (!clean) return "Give the secret a name, e.g. sf_consumer_key.";
    this.values.set(clean, value);
    this.byValue.set(value, clean);
    return `Saved as ${this.handle(clean)}. Type it by writing that handle; the value is filled in at the last moment and never shown.`;
  }

  list(): string {
    const named = new Map<string, string>();
    for (const [value, id] of this.byValue) named.set(id, value);
    return [...named.keys()].map((id) => this.handle(id)).join(", ") || "(none)";
  }

  /** Swap handles for their values, for the executor only. Unknown handles are an error, never
   *  passed through as literal text. */
  reveal(text: string): { text: string } | { error: string } {
    const missing: string[] = [];
    const out = text.replace(HANDLE, (all, id: string) => {
      const v = this.values.get(id);
      if (v === undefined) missing.push(id);
      return v ?? all;
    });
    return missing.length ? { error: `No secret named ${missing.join(", ")} — held: ${this.list()}.` } : { text: out };
  }

  clear(): void {
    this.values.clear();
    this.byValue.clear();
  }

  private keep(value: string): string {
    const held = this.byValue.get(value);
    if (held) return held;
    const id = `s${++this.n}`;
    this.values.set(id, value);
    this.byValue.set(value, id);
    return id;
  }

  private handle(id: string): string {
    const value = this.values.get(id) ?? "";
    return `{{secret:${id} …${value.slice(-4)}}}`;
  }
}

export function hasHandle(text: string): boolean {
  HANDLE.lastIndex = 0;
  return HANDLE.test(text);
}

/** How a handle is said aloud or shown in a one-line summary. */
export function withoutHandles(text: string): string {
  return text.replace(HANDLE, "a secret");
}
