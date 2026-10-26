import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OneShot, createOneShot } from "../server/brain/oneshot.js";

/** A scripted model: each call returns the next answer, and every request body is recorded. */
function scripted(answers: string[], status = 200) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    if (status !== 200) return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status });
    return new Response(JSON.stringify({ choices: [{ message: { content: answers.shift() ?? "" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { one: new OneShot({ apiKey: "k", fetch: fetchImpl }), bodies };
}

const answer = z.object({ answer: z.string().nullable() });

describe("OneShot", () => {
  it("asks for JSON, without streaming, and parses the answer", async () => {
    const { one, bodies } = scripted(['{"answer":"$42"}']);
    expect(await one.json("sys", "user", answer)).toEqual({ answer: "$42" });
    expect(bodies[0]).toMatchObject({ response_format: { type: "json_object" }, stream: false });
    expect(bodies[0]!.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "user" },
    ]);
  });

  it("takes the JSON out of a fenced answer rather than failing on the wrapper", async () => {
    const { one } = scripted(['Sure!\n```json\n{"answer":"$42"}\n```']);
    expect(await one.json("sys", "user", answer)).toEqual({ answer: "$42" });
  });

  it("asks once more, saying what was wrong, then gives up rather than looping", async () => {
    const { one, bodies } = scripted(['{"answer":7}', '{"answer":"$42"}']);
    expect(await one.json("sys", "user", answer)).toEqual({ answer: "$42" });
    expect(String(bodies[1]!.messages).length).toBeGreaterThan(0);
    expect(JSON.stringify(bodies[1]!.messages)).toMatch(/was rejected/);

    const bad = scripted(['{"answer":7}', '{"answer":7}']);
    await expect(bad.one.json("sys", "user", answer)).rejects.toThrow(/didn't fit the shape/);
    expect(bad.bodies).toHaveLength(2); // two attempts, not three
  });

  it("passes the provider's own complaint through", async () => {
    const { one } = scripted([], 429);
    await expect(one.json("sys", "user", answer)).rejects.toThrow(/HTTP 429: rate limited/);
  });

  it("clips a page that is too long to send whole", () => {
    const one = new OneShot({ apiKey: "k", maxInputChars: 10 });
    expect(one.clip("short")).toBe("short");
    expect(one.clip("x".repeat(50))).toMatch(/^x{10}\n…\[the rest/);
  });
});

describe("createOneShot", () => {
  it("needs a key, and honours the task-specific model override", () => {
    expect(createOneShot({} as NodeJS.ProcessEnv)).toBeNull();
    expect(createOneShot({ OPENROUTER_API_KEY: "k" } as NodeJS.ProcessEnv)!.model).toBe("z-ai/glm-5.3-flash");
    expect(createOneShot({ OPENROUTER_API_KEY: "k", JEV_BRAIN_MODEL: "b" } as NodeJS.ProcessEnv)!.model).toBe("b");
    expect(createOneShot({ OPENROUTER_API_KEY: "k", JEV_BRAIN_MODEL: "b", JEV_TASK_MODEL: "t" } as NodeJS.ProcessEnv)!.model).toBe("t");
  });
});
