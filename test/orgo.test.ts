import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { BrainEvent, BrainRun } from "../core/brain.js";
import { compactImages } from "../server/brain/compact.js";
import { AgentBrain } from "../server/brain/agent.js";
import { ChatStore } from "../server/brain/chat-store.js";
import { fileRunLog } from "../server/brain/runlog.js";
import type { Hands } from "../server/brain/tools.js";
import { COFOUNDER_COMPUTER, type Cofounder, type Exchange } from "../server/cofounder.js";
import { OrgoComputer } from "../server/orgo.js";
import { FakeExecutor } from "./helpers/fake-executor.js";

/** Orgo's API as a script: records every call; the computer is "running" unless told otherwise. */
function fakeOrgo(over: { status?: string; bashOutput?: string } = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const p = u.pathname.replace(`/api/computers/${COFOUNDER_COMPUTER}`, "") + u.search;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path: p, body });
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (p === "") return json({ status: over.status ?? "running" });
    if (p.startsWith("/screenshot")) return json({ image: "SHOT", width: 1280, height: 720 });
    if (p === "/bash") return json({ output: over.bashOutput ?? "box-1", exit_code: 0 });
    return json({ success: true });
  }) as unknown as typeof fetch;
  return { calls, orgo: new OrgoComputer({ apiKey: "k", fetch: fetchImpl }) };
}

describe("OrgoComputer", () => {
  it("sends Orgo's own request shapes, and checks the computer is running once, not per click", async () => {
    const { calls, orgo } = fakeOrgo();
    await orgo.click(100, 200, { double: true });
    await orgo.scroll(640, 360, "down", 5);
    await orgo.type("hello");
    await orgo.key("Enter");
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["GET", "", undefined],
      ["POST", "/click", { x: 100, y: 200, button: "left", double: true }],
      ["POST", "/scroll", { x: 640, y: 360, direction: "down", amount: 5 }],
      ["POST", "/type", { text: "hello" }],
      ["POST", "/key", { key: "Enter" }],
    ]);
  });

  it("never starts a stopped computer — it refuses instead", async () => {
    const { calls, orgo } = fakeOrgo({ status: "stopped" });
    await expect(orgo.click(1, 1)).rejects.toThrow(/stopped\. I won't start it/);
    expect(calls.map((c) => c.path)).toEqual([""]);
  });

  it("refuses coordinates off the screen instead of clicking somewhere else", async () => {
    const { orgo } = fakeOrgo();
    await expect(orgo.click(1400, 10)).rejects.toThrow(/off the screen/);
  });
});

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
let seq = 0;
const call = (input: unknown) => ({ content: [{ type: "tool-call" as const, toolCallId: `o${++seq}`, toolName: "orgo", input: JSON.stringify(input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] });
const say = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
const scripted = (steps: unknown[]) => {
  let i = 0;
  return new MockLanguageModelV4({ doGenerate: async () => steps[Math.min(i++, steps.length - 1)] as never });
};
async function drive(model: MockLanguageModelV4, hands: Hands, onApproval: (summary: string) => "once" | "deny" = () => "deny") {
  const brain = new AgentBrain({ model, modelId: "t", hands, instructions: () => "t", log: fileRunLog(mkdtempSync(path.join(tmpdir(), "jev-runs-"))), apps: null, chat: new ChatStore(null) });
  const run: BrainRun = await brain.send("on the co-founder's computer, do it");
  const events: BrainEvent[] = [];
  for await (const e of run.events) {
    events.push(e);
    if (e.kind === "approval") void brain.approve(run.id, onApproval(e.summary), e.requestId);
  }
  return events;
}
const base = () => ({ chrome: new FakeExecutor([], "chrome"), mac: new FakeExecutor([], "mac"), computer: null }) as unknown as Hands;
const idleCofounder = (busy: Exchange | null = null) => ({ busy: async () => busy }) as unknown as Cofounder;

describe("the orgo tool", () => {
  it("clicks, then hands the model the new screen as an image", async () => {
    const { calls, orgo } = fakeOrgo();
    const model = scripted([call({ action: "click", x: 50, y: 60 }), say("Done.")]);
    await drive(model, { ...base(), orgo, cofounder: idleCofounder() });
    expect(calls.some((c) => c.path === "/click")).toBe(true);
    const toolMsg = model.doGenerateCalls[1]!.prompt.find((m) => m.role === "tool")!;
    const out = (toolMsg.content[0] as { output: { type: string; value: Array<{ type: string; mediaType?: string }> } }).output;
    expect(out.type).toBe("content");
    expect(out.value.map((v) => v.type)).toEqual(["text", "file"]);
    expect(out.value[1]!.mediaType).toBe("image/jpeg");
  });

  it("a shell command that changes things asks first; refused, nothing runs", async () => {
    const { calls, orgo } = fakeOrgo();
    const asked: string[] = [];
    await drive(scripted([call({ action: "bash", command: "rm -rf /tmp/x" }), say("OK.")]), { ...base(), orgo, cofounder: idleCofounder() }, (s) => (asked.push(s), "deny"));
    expect(asked).toEqual(["run this on the co-founder's computer: rm -rf /tmp/x"]);
    expect(calls.some((c) => c.path === "/bash")).toBe(false);
  });

  it("a read-only command runs straight away", async () => {
    const { calls, orgo } = fakeOrgo();
    const asked: string[] = [];
    await drive(scripted([call({ action: "bash", command: "hostname" }), say("box-1")]), { ...base(), orgo, cofounder: idleCofounder() }, (s) => (asked.push(s), "deny"));
    expect(asked).toEqual([]);
    expect(calls.filter((c) => c.path === "/bash").map((c) => c.body)).toEqual([{ command: "hostname", timeout: 60 }]);
  });

  it("while the co-founder is mid-task, asks before touching its computer — once per run", async () => {
    const { calls, orgo } = fakeOrgo();
    const asked: string[] = [];
    const busy: Exchange = { id: "d1", sender: "user", recipient: "default", state: "running", body: "research dentists in Austin", result: "", created: 1 };
    await drive(scripted([call({ action: "screenshot" }), call({ action: "click", x: 5, y: 5 }), call({ action: "key", key: "Enter" }), say("Done.")]), { ...base(), orgo, cofounder: idleCofounder(busy) }, (s) => (asked.push(s), "once"));
    expect(asked).toEqual(['act on the co-founder\'s computer while it\'s working on "research dentists in Austin"']);
    expect(calls.filter((c) => c.path === "/click" || c.path === "/key")).toHaveLength(2);
  });

  it("said no while it's busy: nothing is clicked", async () => {
    const { calls, orgo } = fakeOrgo();
    const busy: Exchange = { id: "d1", sender: "user", recipient: "default", state: "queued", body: "x", result: "", created: 1 };
    await drive(scripted([call({ action: "click", x: 5, y: 5 }), say("OK.")]), { ...base(), orgo, cofounder: idleCofounder(busy) }, () => "deny");
    expect(calls.some((c) => c.path === "/click")).toBe(false);
  });
});

describe("screenshots in the history", () => {
  it("only the newest stays an image", () => {
    const shot = (id: string) => ({ role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: id, toolName: "orgo", output: { type: "content" as const, value: [{ type: "text" as const, text: id }, { type: "file" as const, mediaType: "image/jpeg", data: { type: "data" as const, data: "X" } }] } }] });
    const out = compactImages([shot("a"), shot("b"), shot("c")]);
    const kinds = out.map((m) => ((m as ReturnType<typeof shot>).content[0]!.output.value as Array<{ type: string }>).map((v) => v.type).join(","));
    expect(kinds).toEqual(["text,text", "text,text", "text,file"]);
  });
});
