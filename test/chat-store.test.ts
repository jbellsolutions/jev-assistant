import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { BrainEvent, BrainRun } from "../core/brain.js";
import { AgentBrain } from "../server/brain/agent.js";
import { ChatStore } from "../server/brain/chat-store.js";
import { fileRunLog } from "../server/brain/runlog.js";
import type { Hands } from "../server/brain/tools.js";
import { FakeExecutor } from "./helpers/fake-executor.js";

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const say = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
const scripted = (...answers: string[]) => {
  let i = 0;
  return new MockLanguageModelV4({ doGenerate: async () => say(answers[Math.min(i++, answers.length - 1)]!) as never });
};
const hanging = () =>
  new MockLanguageModelV4({
    doGenerate: (opts) =>
      new Promise((_r, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (opts.abortSignal?.aborted) return abort(); // as fetch does with an already-aborted signal
        opts.abortSignal?.addEventListener("abort", abort, { once: true });
      }),
  });
const hands = { chrome: new FakeExecutor([], "chrome"), mac: new FakeExecutor([], "mac"), computer: { openApp: async () => "", findFiles: async () => [], openPath: async () => "" } } as unknown as Hands;
const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), "jev-chat-")), "chat.json");
const brain = (model: MockLanguageModelV4, chat: ChatStore) =>
  new AgentBrain({ model, modelId: "test/model", hands, instructions: () => "test", log: fileRunLog(mkdtempSync(path.join(tmpdir(), "jev-runs-"))), apps: null, chat });
async function drain(run: BrainRun): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const e of run.events) out.push(e);
  return out;
}
const prompt = (m: MockLanguageModelV4, i: number) => JSON.stringify(m.doGenerateCalls[i]!.prompt);

describe("the chat store", () => {
  it("survives a restart: a new store over the same file has the turns", () => {
    const file = tmpFile();
    new ChatStore(file).append("the code word is pelican", "Got it.");
    const again = new ChatStore(file);
    expect(again.chat.turns.map((t) => t.user)).toEqual(["the code word is pelican"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("starts empty on a missing or unreadable file rather than refusing to run", () => {
    const file = tmpFile();
    writeFileSync(file, "{not json");
    expect(new ChatStore(file).chat.turns).toEqual([]);
  });

  it("reset starts a new chat, on disk too", () => {
    const file = tmpFile();
    const s = new ChatStore(file);
    s.append("a", "b");
    s.reset();
    expect(new ChatStore(file).chat.turns).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8")).turns).toEqual([]);
  });

  it("recent() keeps the newest turns within both caps", () => {
    const s = new ChatStore(null);
    for (const q of ["one", "two", "three"]) s.append(q, "ok");
    expect(s.recent(2, 1_000).map((t) => t.user)).toEqual(["two", "three"]);
    expect(s.recent(10, 11).map((t) => t.user)).toEqual(["three"]);
  });
});

describe("one ongoing chat", () => {
  it("a restarted brain still has the conversation", async () => {
    const file = tmpFile();
    await drain(await brain(scripted("Got it."), new ChatStore(file)).send("remember the code word is pelican"));
    const model = scripted("Pelican.");
    await drain(await brain(model, new ChatStore(file)).send("what's the code word?"));
    expect(prompt(model, 0)).toContain("pelican");
  });

  it("a stopped run is kept, so 'carry on' makes sense", async () => {
    const chat = new ChatStore(null);
    const b = brain(hanging(), chat);
    const run = await b.send("check slack");
    setTimeout(() => void b.stop(run.id), 20);
    await drain(run);
    expect(chat.chat.turns).toEqual([expect.objectContaining({ user: "check slack", assistant: "(stopped before answering)" })]);
  });

  it("a task that failed is kept; a model error is not (it's retried with the same words)", async () => {
    const failing = (msg: string) => new MockLanguageModelV4({ doGenerate: async () => { throw new Error(msg); } });
    const chat = new ChatStore(null);
    await drain(await brain(failing("HTTP 500: Internal Server Error"), chat).send("first"));
    expect(chat.chat.turns).toEqual([]);
    await drain(await brain(failing("the page never loaded"), chat).send("second"));
    expect(chat.chat.turns[0]!.assistant).toMatch(/^\(couldn't finish: the page never loaded/);
  });

  it("a fresh retry sends no history but never erases the chat", async () => {
    const chat = new ChatStore(null);
    chat.append("the code word is pelican", "Got it.");
    const model = scripted("ok");
    await drain(await brain(model, chat).send("try again", { fresh: true }));
    expect(prompt(model, 0)).not.toContain("pelican");
    expect(chat.chat.turns.map((t) => t.user)).toEqual(["the code word is pelican", "try again"]);
  });

  it("'new chat' empties it", async () => {
    const chat = new ChatStore(null);
    chat.append("the code word is pelican", "Got it.");
    const model = scripted("I don't know.");
    const b = brain(model, chat);
    await b.reset();
    await drain(await b.send("what's the code word?"));
    expect(prompt(model, 0)).not.toContain("pelican");
  });

  it("something done straight away is in view for the next question", async () => {
    const chat = new ChatStore(null);
    const model = scripted("It's open.");
    const b = brain(model, chat);
    b.remember("open slack", "Opened Slack");
    await drain(await b.send("is it open?"));
    expect(prompt(model, 0)).toContain("Opened Slack");
    expect(b.chatInfo().turns).toBe(2);
  });
});

describe("'new chat' while a run is still going", () => {
  it("the old run's ending doesn't land in the new chat", async () => {
    const chat = new ChatStore(null);
    const b = brain(hanging(), chat);
    const run = await b.send("remember the code word is pelican");
    // what Session.resetBrain does: stop (not awaited), then reset
    void b.stop(run.id);
    await b.reset();
    await drain(run);
    expect(chat.chat.turns).toEqual([]);
  });

  it("JEV_CHAT_FILE=off keeps the chat in memory, never a file called 'off'", async () => {
    const { createAgentBrain } = await import("../server/brain/agent.js");
    const dir = mkdtempSync(path.join(tmpdir(), "jev-cwd-"));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const b = createAgentBrain({ OPENROUTER_API_KEY: "sk-test", JEV_CHAT_FILE: "off" }, { hands })!;
      b.remember("open slack", "Opened Slack");
      expect(() => statSync(path.join(dir, "off"))).toThrow();
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("a request from the co-founder", () => {
  it("gets no cofounder tool (no loops), is told who's asking, and stays out of the user's chat", async () => {
    const chat = new ChatStore(null);
    chat.append("the code word is pelican", "Got it.");
    const model = scripted("Done.");
    const b = brain(model, chat);
    await drain(await b.send("open Slack for me", { from: "cofounder" }));
    const call0 = model.doGenerateCalls[0]!;
    expect((call0.tools ?? []).map((t) => t.name)).not.toContain("cofounder");
    expect(JSON.stringify(call0.prompt)).toMatch(/comes from the user's co-founder agent/);
    expect(JSON.stringify(call0.prompt)).not.toContain("pelican");
    expect(chat.chat.turns.map((t) => t.user)).toEqual(["the code word is pelican"]);
    // the user's own next run still has his chat, and not the co-founder's turn
    const model2 = scripted("ok");
    const b2 = brain(model2, chat);
    await drain(await b2.send("what's the code word?"));
    expect(JSON.stringify(model2.doGenerateCalls[0]!.prompt)).toContain("pelican");
    expect((model2.doGenerateCalls[0]!.tools ?? []).map((t) => t.name)).toContain("cofounder");
  });
});
