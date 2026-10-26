import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelArbiter, createArbiter } from "../server/review/arbiter.js";
import { OneShot } from "../server/brain/oneshot.js";

/** An OpenRouter stand-in: records each request and answers from a script. */
function openrouter(answers: string[]) {
  const calls: Array<{ url: string; body: { model: string; messages: Array<{ role: string; content: string }> } }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const content = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const schema = z.object({ items: z.array(z.object({ id: z.string(), decision: z.enum(["adopt", "pilot", "watch", "reject"]) })) });

describe("the review's Arbiter", () => {
  it("is the OpenRouter model, never Hermes — even when Hermes is configured", async () => {
    const { impl, calls } = openrouter(['{"items":[{"id":"a","decision":"pilot"}]}']);
    const arbiter = createArbiter({ OPENROUTER_API_KEY: "k", HERMES_API_KEY: "h", HERMES_API_URL: "http://127.0.0.1:8642" } as NodeJS.ProcessEnv, { fetch: impl })!;
    expect(arbiter).toBeInstanceOf(ModelArbiter);
    const got = await arbiter.json(schema, "Candidates: a", "You are the Arbiter.");
    expect(got.items[0]!.decision).toBe("pilot");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("openrouter.ai");
    expect(calls[0]!.body.messages[0]).toEqual({ role: "system", content: "You are the Arbiter." });
    expect(arbiter.model).toBe("z-ai/glm-5.3-flash");
  });

  it("needs only an OpenRouter key, and takes a model of its own when set", () => {
    expect(createArbiter({ HERMES_API_KEY: "h" } as NodeJS.ProcessEnv)).toBeNull();
    expect(createArbiter({ OPENROUTER_API_KEY: "k", JEV_REVIEW_ARBITER_MODEL: "x/judge" } as NodeJS.ProcessEnv)!.model).toBe("x/judge");
  });

  it("complains once about a malformed answer, then fails that question rather than guessing", async () => {
    const { impl, calls } = openrouter(['{"items":[{"id":"a","decision":"maybe"}]}']);
    const arbiter = new ModelArbiter(new OneShot({ apiKey: "k", fetch: impl }));
    await expect(arbiter.json(schema, "Candidates: a")).rejects.toThrow(/didn't fit the shape/);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.messages[1]!.content).toContain("Your last answer was rejected");
  });
});
