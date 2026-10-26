/** One bounded question to a model, answered as JSON. Deliberately not an agent and not a
 *  conversation: no history, no tools, no streaming, no run to steer — a single request that
 *  either parses into the shape asked for or fails, so the caller (the Monday/Thursday review)
 *  stays the thing in charge, and a failure belongs to one row rather than to the whole job. */
import { z } from "zod";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_ONESHOT_MODEL = "z-ai/glm-5.3-flash";

export interface OneShotOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetch?: typeof fetch;
  /** A hung request would hang the whole run: the loop's per-item cap does not cover planning. */
  timeoutMs?: number;
  /** Ceiling on the page text handed to the model; the rest is dropped with a marker. */
  maxInputChars?: number;
}

const MAX_INPUT_CHARS = 12_000;

export class OneShot {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: OneShotOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  get model(): string {
    return this.opts.model ?? DEFAULT_ONESHOT_MODEL;
  }

  /** Ask once; on a malformed answer ask again, once, saying what was wrong. Then give up —
   *  a third attempt is a worse use of the user's time than an honest "this row failed". */
  async json<T>(system: string, user: string, schema: z.ZodType<T>): Promise<T> {
    let complaint: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const content = await this.call(system, complaint ? `${user}\n\nYour last answer was rejected: ${complaint}\nAnswer again, as JSON only.` : user);
      const parsed = schema.safeParse(parseJson(content));
      if (parsed.success) return parsed.data;
      complaint = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    }
    throw new Error(`the model's answer didn't fit the shape asked for (${complaint})`);
  }

  private async call(system: string, user: string): Promise<string> {
    const res = await this.fetchImpl(this.opts.endpoint ?? ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        stream: false,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } | string } | null;
      const detail = typeof body?.error === "string" ? body.error : body?.error?.message;
      throw new Error(detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`);
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("the model returned an empty answer");
    return content;
  }

  clip(text: string): string {
    const max = this.opts.maxInputChars ?? MAX_INPUT_CHARS;
    return text.length <= max ? text : `${text.slice(0, max)}\n…[the rest of the page was too long to include]`;
  }
}

/** Models fenced JSON even when asked not to; take the object rather than fail on the wrapper. */
function parseJson(content: string): unknown {
  const text = content.trim();
  const candidates = [text];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const braced = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (braced) candidates.push(braced);
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

export function createOneShot(env: NodeJS.ProcessEnv = process.env): OneShot | null {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  return new OneShot({ apiKey, model: env.JEV_TASK_MODEL?.trim() || env.JEV_BRAIN_MODEL?.trim() || DEFAULT_ONESHOT_MODEL });
}
