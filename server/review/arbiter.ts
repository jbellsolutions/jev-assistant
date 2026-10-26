/** The Arbiter: the review's final judge (adopt / pilot / watch / reject), asked as one bounded JSON
 *  question to the same OpenRouter model as the Scout and the Surveyor — and the same model as Jev's
 *  brain. It used to be a Hermes run; the user chose (2026-09-25) to take Hermes out of the review, so
 *  a Monday run no longer depends on a second agent's gateway being up.
 *
 *  `deliberate.ts` only ever calls `json(schema, input, instructions)`, so that is the whole surface.
 *  Parse tolerantly, validate with zod, complain once, then fail that question rather than guess —
 *  the discipline lives in OneShot. */
import type { z } from "zod";
import { DEFAULT_ONESHOT_MODEL, OneShot } from "../brain/oneshot.js";

/** What the deliberation needs from a judge. */
export interface Arbiter {
  json<T>(schema: z.ZodType<T>, input: string, instructions?: string): Promise<T>;
  /** Which model judged, for the note. */
  readonly model: string;
}

export class ModelArbiter implements Arbiter {
  constructor(private readonly one: OneShot) {}

  get model(): string {
    return this.one.model;
  }

  json<T>(schema: z.ZodType<T>, input: string, instructions?: string): Promise<T> {
    return this.one.json(instructions ?? "Answer as JSON only.", input, schema);
  }
}

/** The Arbiter for this environment: OpenRouter only. Null without a key. `timeoutMs` is the
 *  review's own, longer budget (a scheduled job has nobody waiting). */
export function createArbiter(env: NodeJS.ProcessEnv = process.env, opts: { timeoutMs?: number; fetch?: typeof fetch } = {}): ModelArbiter | null {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  const model = env.JEV_REVIEW_ARBITER_MODEL?.trim() || env.JEV_TASK_MODEL?.trim() || env.JEV_BRAIN_MODEL?.trim() || DEFAULT_ONESHOT_MODEL;
  return new ModelArbiter(new OneShot({ apiKey, model, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) }));
}
