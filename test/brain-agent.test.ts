import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { BrainEvent, BrainRun } from "../core/brain.js";
import { AgentBrain, CAP_LINE, WALL_LINE, WRAP_UP, createAgentBrain } from "../server/brain/agent.js";
import { APP_ACTIONS, APP_WRITES, type AppsLoader, toolkitOf } from "../server/brain/apps.js";
import { fileRunLog } from "../server/brain/runlog.js";
import { BrowserBox } from "../server/browserbox.js";
import { type Hands, TOOL_NAMES, actionWrites, opensBrowser, shellIsReadOnly } from "../server/brain/tools.js";
import { FakeExecutor, el } from "./helpers/fake-executor.js";

type GenResult = ConstructorParameters<typeof MockLanguageModelV4>[0] extends infer O ? (O extends { doGenerate?: infer G } ? Exclude<G, Function | unknown[]> : never) : never;

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
let callSeq = 0;
const say = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] }) as unknown as GenResult;
const call = (toolName: string, input: unknown) =>
  ({ content: [{ type: "tool-call" as const, toolCallId: `c${++callSeq}`, toolName, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] }) as unknown as GenResult;

/** A model that answers from a script, one entry per step; the last entry repeats. */
function scripted(steps: GenResult[]) {
  let i = 0;
  return new MockLanguageModelV4({ doGenerate: async () => steps[Math.min(i++, steps.length - 1)]! });
}

/** A model that never answers until its call is aborted. */
function hanging() {
  return new MockLanguageModelV4({
    doGenerate: (opts) =>
      new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      }),
  });
}

function hands(over: Partial<Hands> = {}) {
  const chrome = new FakeExecutor([el("e0", { tag: "button", text: "Send", label: "Send" }), el("e1", { tag: "a", text: "general", label: "general" })], "chrome");
  const mac = new FakeExecutor([el("e0", { tag: "button", label: "Delete draft" })], "mac");
  const opened: string[] = [];
  const computer = { openApp: async (a: string) => (opened.push(a), `Opened ${a}`), findFiles: async () => [], openPath: async (p: string) => `Opened ${p}` };
  return { chrome, mac, opened, hands: { chrome, mac, computer, ...over } as Hands };
}

async function collect(run: BrainRun, onEvent?: (e: BrainEvent) => void): Promise<BrainEvent[]> {
  const seen: BrainEvent[] = [];
  for await (const e of run.events) {
    seen.push(e);
    onEvent?.(e);
  }
  return seen;
}

const brainWith = (model: MockLanguageModelV4, h: Hands, limits = {}, log = fileRunLog(mkdtempSync(path.join(tmpdir(), "jev-runs-"))), apps: AppsLoader | null = null) =>
  new AgentBrain({ model, modelId: "test/model", hands: h, instructions: () => "You are a test.", limits, log, apps });

describe("the brain's tool list", () => {
  it("enforces a worker's tool boundary in the actual model request", async () => {
    const model = scripted([say("ready")]); const brain = new AgentBrain({ model, modelId: "test", hands: hands().hands, instructions: () => "Only Orgo", ownTools: ["orgo"], apps: null });
    await collect(await brain.send("read the remote screen"));
    expect((model.doGenerateCalls[0]!.tools ?? []).map((t) => t.name)).toEqual(["orgo"]);
  });
  it("is short, named, and exactly what the model is offered", async () => {
    const model = scripted([say("hi")]);
    const brain = brainWith(model, hands().hands);
    await collect(await brain.send("hello"));
    expect(TOOL_NAMES).toEqual(["mac_read", "mac_act", "mac_control", "chrome", "browser_box", "shell", "cofounder", "orgo", "secret"]);
    const offered = (model.doGenerateCalls[0]!.tools ?? []).map((t) => t.name).sort();
    expect(offered).toEqual([...TOOL_NAMES].sort());
  });
});

describe("a run that answers", () => {
  it("streams the answer, completes, and remembers the turn as plain text", async () => {
    const model = scripted([say("Loud and clear.")]);
    const brain = brainWith(model, hands().hands);
    const events = await collect(await brain.send("can you hear me"));
    expect(events.at(-1)).toEqual({ kind: "completed", output: "Loud and clear." });
    await collect(await brain.send("and now?"));
    const prompt = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    expect(prompt).toContain("can you hear me");
    expect(prompt).toContain("Loud and clear.");
  });
});

describe("every run is bounded", () => {
  it("stops at the step cap and says so, rather than wandering", async () => {
    const model = scripted([call("mac_read", {})]); // reads forever
    const brain = brainWith(model, hands().hands, { maxSteps: 3 });
    const events = await collect(await brain.send("find everything"));
    expect(model.doGenerateCalls.length).toBe(4); // three steps, and a wrap-up that also only wanted tools
    expect(events.at(-1)).toEqual({ kind: "completed", output: CAP_LINE });
  });

  it("ends in an answer from what it found, not \"I stopped\", when the steps run out", async () => {
    // Live 2026-09-25: "check Slack" had the answer by step 9 and ended with only "I stopped".
    // The wrap-up is a separate call with no tools, answering from what the tools handed back.
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => ((opts as { tools?: unknown[] }).tools?.length ? call("mac_read", {}) : say("Dan asked for app feedback.")),
    });
    const brain = brainWith(model, hands().hands, { maxSteps: 3 });
    const events = await collect(await brain.send("check slack"));
    expect(events.at(-1)).toEqual({ kind: "completed", output: "Dan asked for app feedback." });
    expect(model.doGenerateCalls.length).toBe(4); // three steps, then the wrap-up
    const last = JSON.stringify(model.doGenerateCalls[3]!.prompt);
    expect(last).toContain("What your tools found");
    expect(last).toContain(WRAP_UP.slice(0, 30));
  });

  it("stops exploring while there is still time to answer", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => ((opts as { tools?: unknown[] }).tools?.length ? call("mac_read", {}) : say("Here is what I found.")),
    });
    const brain = brainWith(model, hands().hands, { maxSteps: 20, maxWallMs: 10_000, wrapUpMs: 10_000 });
    const events = await collect(await brain.send("check slack"));
    expect(model.doGenerateCalls.length).toBe(2); // one read, then the answer
    expect(events.at(-1)).toEqual({ kind: "completed", output: "Here is what I found." });
  });

  it("does not pass off a tool call written as text as the answer", async () => {
    // GLM, given no tools, wrote `<tool_call>mac_act<arg_key>…` as its reply.
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => (++n === 1 ? call("mac_read", {}) : n === 2 ? say("<tool_call>mac_act<arg_key>action</arg_key></tool_call>") : say("Nothing new since Wednesday.")),
    });
    const brain = brainWith(model, hands().hands);
    const events = await collect(await brain.send("check slack"));
    expect(events.at(-1)).toEqual({ kind: "completed", output: "Nothing new since Wednesday." });
  });

  it("stops at the wall clock", async () => {
    const brain = brainWith(hanging(), hands().hands, { maxWallMs: 50 });
    const events = await collect(await brain.send("think forever"));
    expect(events.at(-1)).toEqual({ kind: "completed", output: WALL_LINE });
  });

  it("Stop cancels a run mid-call", async () => {
    const brain = brainWith(hanging(), hands().hands);
    const run = await brain.send("think forever");
    setTimeout(() => void brain.stop(run.id), 20);
    const events = await collect(run);
    expect(events.at(-1)).toEqual({ kind: "cancelled" });
  });

  it("carries only the last few turns, not the whole conversation", async () => {
    const model = scripted([say("ok")]);
    const brain = brainWith(model, hands().hands, { historyTurns: 2 });
    for (const q of ["first", "second", "third", "fourth"]) await collect(await brain.send(q));
    const prompt = JSON.stringify(model.doGenerateCalls[3]!.prompt);
    expect(prompt).not.toContain("first");
    expect(prompt).toContain("second");
    expect(prompt).toContain("third");
  });

  it("caps the carried history by size too, dropping the oldest first", async () => {
    const model = scripted([say("ok")]);
    const brain = brainWith(model, hands().hands, { historyChars: 30 });
    await collect(await brain.send("an older question that is fairly long"));
    await collect(await brain.send("recent"));
    await collect(await brain.send("now"));
    const prompt = JSON.stringify(model.doGenerateCalls[2]!.prompt);
    expect(prompt).toContain("recent");
    expect(prompt).not.toContain("an older question");
  });
});

describe("writes ask first", () => {
  it("uses owner permissions for browser actions and honors revocation on the next action", async () => {
    const { chrome, hands: h } = hands();
    let enabled = true;
    const brain = new AgentBrain({ model: scripted([call("chrome", { action: "read_elements" }), call("chrome", { action: "click", element_id: "e0" }), say("Done")]), modelId: "test", hands: h, instructions: () => "Perform the requested work", apps: null, permissionsEnabled: () => enabled });
    const events = await collect(await brain.send("send it"));
    expect(events.some((e) => e.kind === "approval")).toBe(false);
    expect(chrome.executed).toHaveLength(1);
    enabled = false;
    const model = scripted([call("chrome", { action: "read_elements" }), call("chrome", { action: "click", element_id: "e0" }), say("Stopped")]);
    const revoked = new AgentBrain({ model, modelId: "test", hands: h, instructions: () => "test", apps: null, permissionsEnabled: () => enabled });
    const run = await revoked.send("send it");
    const after = await collect(run, (e) => { if (e.kind === "approval") void revoked.approve(run.id, "deny", e.requestId); });
    expect(after.some((e) => e.kind === "approval")).toBe(true);
    expect(chrome.executed).toHaveLength(1);
  });
  it("does not give co-founder-originated requests the owner's enabled permissions", async () => {
    const { chrome, hands: h } = hands();
    const brain = new AgentBrain({ model: scripted([call("chrome", { action: "read_elements" }), call("chrome", { action: "click", element_id: "e0" }), say("Stopped")]), modelId: "test", hands: h, instructions: () => "test", apps: null, permissionsEnabled: () => true });
    const run = await brain.send("send it", { from: "cofounder" });
    const events = await collect(run, (e) => { if (e.kind === "approval") void brain.approve(run.id, "deny", e.requestId); });
    expect(events.some((e) => e.kind === "approval")).toBe(true);
    expect(chrome.executed).toEqual([]);
  });
  it("waits for a yes before clicking Send, then does it", async () => {
    const { chrome, hands: h } = hands();
    const brain = brainWith(scripted([call("chrome", { action: "read_elements" }), call("chrome", { action: "click", element_id: "e0" }), say("Sent.")]), h);
    const run = await brain.send("send it");
    const events = await collect(run, (e) => {
      if (e.kind === "approval") {
        expect(chrome.executed).toEqual([]); // nothing happens while it waits
        void brain.approve(run.id, "once", e.requestId);
      }
    });
    expect(events.find((e) => e.kind === "approval")).toMatchObject({ summary: 'click "Send" in Chrome' });
    expect(chrome.executed).toEqual([{ kind: "click", elementId: "e0", label: "Send" }]);
  });

  it("a no means it does not happen", async () => {
    const { chrome, hands: h } = hands();
    const model = scripted([call("chrome", { action: "read_elements" }), call("chrome", { action: "click", element_id: "e0" }), say("Okay, I didn't send it.")]);
    const brain = brainWith(model, h);
    const run = await brain.send("send it");
    await collect(run, (e) => {
      if (e.kind === "approval") void brain.approve(run.id, "deny", e.requestId);
    });
    expect(chrome.executed).toEqual([]);
    expect(JSON.stringify(model.doGenerateCalls[2]!.prompt)).toContain("the user said no");
  });

  it("Stop while it is waiting means no, and the run ends", async () => {
    const { chrome, hands: h } = hands();
    const brain = brainWith(scripted([call("chrome", { action: "read_elements" }), call("chrome", { action: "click", element_id: "e0" }), say("x")]), h);
    const run = await brain.send("send it");
    const events = await collect(run, (e) => {
      if (e.kind === "approval") void brain.stop(run.id);
    });
    expect(chrome.executed).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: "cancelled" });
  });

  it("a harmless click does not ask", async () => {
    const { chrome, hands: h } = hands();
    const brain = brainWith(scripted([call("chrome", { action: "read_elements" }), call("chrome", { action: "click", element_id: "e1" }), say("Opened general.")]), h);
    const events = await collect(await brain.send("open general"));
    expect(events.some((e) => e.kind === "approval")).toBe(false);
    expect(chrome.executed).toEqual([{ kind: "click", elementId: "e1", label: "general" }]);
  });

  it("decides writes from the action itself", () => {
    expect(actionWrites({ kind: "click", elementId: "e0", label: "Send" })).toBe(true);
    expect(actionWrites({ kind: "click", elementId: "e0", label: "Delete draft" })).toBe(true);
    expect(actionWrites({ kind: "click", elementId: "e1", label: "general" })).toBe(false);
    expect(actionWrites({ kind: "type", elementId: "e2", label: "Message", text: "hi", submit: true })).toBe(true);
    expect(actionWrites({ kind: "type", elementId: "e2", label: "Search", text: "hi", submit: false })).toBe(false);
    // Enter in a search box searches — the user's "check Slack" was stalled asking to search for a name
    expect(actionWrites({ kind: "type", elementId: "e23", label: "Search query", text: "Abdul", submit: true })).toBe(false);
    expect(actionWrites({ kind: "type", elementId: "e3", label: "Search mail", text: "invoice", submit: true })).toBe(false);
    // …but not a field that also names a write, and not one with no label
    expect(actionWrites({ kind: "type", elementId: "e4", label: "Search and send", text: "x", submit: true })).toBe(true);
    expect(actionWrites({ kind: "type", elementId: "e5", label: "Message #search-team", text: "x", submit: true })).toBe(true);
    expect(actionWrites({ kind: "type", elementId: "e6", label: null, text: "x", submit: true })).toBe(true);
    expect(actionWrites({ kind: "press", key: "Enter" })).toBe(true);
    expect(actionWrites({ kind: "scroll", direction: "down" })).toBe(false);
  });

  it("runs read-only shell commands and asks about everything else", () => {
    expect(shellIsReadOnly("ls ~/Downloads")).toBe(true);
    expect(shellIsReadOnly("mdfind resume")).toBe(true);
    expect(shellIsReadOnly("hostname")).toBe(true);
    expect(shellIsReadOnly("hostname evil")).toBe(false); // sets it
    expect(shellIsReadOnly("uname -a")).toBe(true);
    expect(shellIsReadOnly("rm -rf ~/Downloads")).toBe(false);
    expect(shellIsReadOnly("ls | xargs rm")).toBe(false);
    expect(shellIsReadOnly("cat a > b")).toBe(false);
    expect(shellIsReadOnly("echo $(rm x)")).toBe(false);
    expect(shellIsReadOnly("find . -delete")).toBe(false);
    expect(shellIsReadOnly("find . -name '*.pdf'")).toBe(true);
  });
});

describe("computer use is grounded", () => {
  it("refuses to act on an element it has not read", async () => {
    const { chrome, hands: h } = hands();
    const model = scripted([call("chrome", { action: "click", element_id: "e7" }), say("I need to read first.")]);
    const brain = brainWith(model, h);
    await collect(await brain.send("click the thing"));
    expect(chrome.executed).toEqual([]);
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("Read first");
  });

  it("says plainly when Chrome is not connected, instead of improvising", async () => {
    const { hands: h } = hands({ chrome: Object.assign(new FakeExecutor([]), { ready: false }) });
    const model = scripted([call("chrome", { action: "read_elements" }), say("Your Chrome isn't connected.")]);
    await collect(await brainWith(model, h).send("check my inbox"));
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("isn't connected");
  });
});

describe("failures", () => {
  it("marks a provider outage as one, so the session can retry it", async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("HTTP 500: Internal Server Error"); } });
    const events = await collect(await brainWith(model, hands().hands).send("hi"));
    expect(events.at(-1)).toMatchObject({ kind: "failed", providerFailure: true });
  });
});

describe("visibility: every run leaves a log", () => {
  it("records the utterance, each tool call with its result, and why it stopped", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jev-runs-"));
    const brain = brainWith(scripted([call("chrome", { action: "read_text" }), say("It costs $42.")]), hands().hands, {}, fileRunLog(dir));
    await collect(await brain.send("what does it cost"));
    const [day] = readdirSync(dir);
    const [file] = readdirSync(path.join(dir, day!));
    const lines = readFileSync(path.join(dir, day!, file!), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; reason?: string; output?: string; tool?: string });
    expect(lines.map((l) => l.type)).toEqual(["start", "tool_start", "tool_end", "step", "step", "end"]);
    expect(lines.find((l) => l.type === "tool_end")).toMatchObject({ tool: "chrome", output: expect.stringContaining("$42") });
    expect(lines.at(-1)).toMatchObject({ reason: "answered", output: "It costs $42." });
  });
});

describe("steering a run", () => {
  it("adds what the user said to the rest of the run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        n++;
        if (n === 1) {
          await gate;
          return call("mac_read", {});
        }
        return say("Done.");
      },
    });
    const brain = brainWith(model, hands().hands);
    const run = await brain.send("check slack");
    await brain.steer(run.id, "and also check email");
    release();
    await collect(run);
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("and also check email");
  });
});

describe("the model is always OpenRouter, never Vercel's gateway", () => {
  it("builds an explicit OpenRouter model from the key, and nothing without one", () => {
    const h = hands().hands;
    expect(createAgentBrain({}, { hands: h })).toBeNull();
    const brain = createAgentBrain({ OPENROUTER_API_KEY: "sk-test" }, { hands: h })!;
    const model = brain.model as { provider: string; modelId: string };
    expect(typeof model).toBe("object"); // a bare string would route through the gateway
    expect(model.provider).toMatch(/^openrouter/);
    expect(model.modelId).toBe("z-ai/glm-5.3-flash");
  });

  it("asks the model to think briefly — the default thinking made each late step take 20–40s", () => {
    const h = hands().hands;
    const settings = (b: ReturnType<typeof createAgentBrain>) => (b!.model as unknown as { settings: { reasoning?: { effort?: string } } }).settings;
    expect(settings(createAgentBrain({ OPENROUTER_API_KEY: "sk-test" }, { hands: h }))?.reasoning?.effort).toBe("low");
    expect(settings(createAgentBrain({ OPENROUTER_API_KEY: "sk-test", JEV_BRAIN_REASONING: "high" }, { hands: h }))?.reasoning?.effort).toBe("high");
  });
});

describe("browser_box: Jev's own browsers", () => {
  /** A browser-box gateway that answers from a script and records every call. */
  function fakeBox(answers: Record<string, unknown[]>) {
    const calls: Array<{ tool: string; body: unknown; auth: string | null }> = [];
    const box = new BrowserBox({
      url: "http://box.test",
      token: "bb-token",
      fetch: (async (url: string, init: RequestInit) => {
        const tool = url.split("/").pop()!;
        calls.push({ tool, body: init.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init.headers).get("authorization") });
        const next = answers[tool]?.shift() ?? {};
        return new Response(JSON.stringify(next), { status: 200 });
      }) as unknown as typeof fetch,
    });
    return { box, calls };
  }

  it("reads a page through the gateway, with the token, and hands the model its text", async () => {
    const { box, calls } = fakeBox({ read: [{ title: "Acme", final_url: "https://acme.test", status_code: 200, text: "Pro is $42", links: [] }] });
    const model = scripted([call("browser_box", { action: "read", url: "https://acme.test" }), say("Pro is $42.")]);
    await collect(await brainWith(model, hands({ box }).hands).send("what does acme pro cost"));
    expect(calls).toEqual([{ tool: "read", body: { url: "https://acme.test" }, auth: "Bearer bb-token" }]);
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("Pro is $42");
  });

  it("routes browser-box's own 'this looks risky' through the user, and a no cancels it there too", async () => {
    const { box, calls } = fakeBox({ act: [{ status: "needs_confirmation", action: "Click Send", reason: "risk 80%" }, { status: "done", steps: [] }] });
    const model = scripted([call("browser_box", { action: "act", command: "click send" }), say("Not sent.")]);
    const brain = brainWith(model, hands({ box }).hands);
    const run = await brain.send("send it from the box");
    const events = await collect(run, (e) => {
      if (e.kind === "approval") void brain.approve(run.id, "deny", e.requestId);
    });
    expect(events.find((e) => e.kind === "approval")).toMatchObject({ summary: "click Send in Jev's own browser" });
    expect(calls.map((c) => c.body)).toEqual([{ command: "click send" }, { confirm: false }]);
  });

  it("says plainly when browser-box is not configured", async () => {
    const model = scripted([call("browser_box", { action: "fetch", url: "https://acme.test" }), say("It isn't set up.")]);
    await collect(await brainWith(model, hands().hands).send("fetch acme"));
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("isn't configured");
  });
});

describe("connectors (Composio): a named list, and writes ask first", () => {
  function fakeApps() {
    const sent: unknown[] = [];
    const apps: AppsLoader = {
      load: async () => ({
        note: "2 app actions (slack)",
        tools: {
          SLACK_FETCH_CONVERSATION_HISTORY: tool({ description: "history", inputSchema: z.object({ channel: z.string() }), execute: async () => "Xander: can you send the deck?" }),
          SLACK_SEND_MESSAGE: tool({ description: "send", inputSchema: z.object({ channel: z.string(), markdown_text: z.string() }), execute: async (a) => (sent.push(a), "ok: sent") }),
        },
      }),
    };
    return { apps, sent };
  }

  it("reads through the API without asking, and a send waits for a yes", async () => {
    const { apps, sent } = fakeApps();
    const model = scripted([call("SLACK_FETCH_CONVERSATION_HISTORY", { channel: "C123" }), call("SLACK_SEND_MESSAGE", { channel: "C123", markdown_text: "On it" }), say("Replied.")]);
    const brain = brainWith(model, hands().hands, {}, undefined, apps);
    const run = await brain.send("reply to xander on it");
    const asks: string[] = [];
    await collect(run, (e) => {
      if (e.kind === "approval") {
        asks.push(e.summary);
        expect(sent).toEqual([]);
        void brain.approve(run.id, "once", e.requestId);
      }
    });
    expect(asks).toEqual(["send a Slack message: C123 — On it"]);
    expect(sent).toEqual([{ channel: "C123", markdown_text: "On it" }]);
  });

  it("a no means the message is not sent", async () => {
    const { apps, sent } = fakeApps();
    const brain = brainWith(scripted([call("SLACK_SEND_MESSAGE", { channel: "C123", markdown_text: "hi" }), say("Not sent.")]), hands().hands, {}, undefined, apps);
    const run = await brain.send("say hi");
    await collect(run, (e) => {
      if (e.kind === "approval") void brain.approve(run.id, "deny", e.requestId);
    });
    expect(sent).toEqual([]);
  });

  it("an outage loading the connectors never breaks a run, and the health line says so", async () => {
    const apps: AppsLoader = { load: async () => { throw new Error("401 invalid key"); } };
    const brain = brainWith(scripted([say("Hi.")]), hands().hands, {}, undefined, apps);
    const events = await collect(await brain.send("hello"));
    expect(events.at(-1)).toEqual({ kind: "completed", output: "Hi." });
    expect((await brain.health()).detail).toMatch(/connectors: unavailable \(401 invalid key\)/);
  });

  it("every write in the list is gated, and the list stays short", () => {
    expect(APP_ACTIONS.length).toBeLessThanOrEqual(20);
    for (const w of Object.keys(APP_WRITES)) expect(APP_ACTIONS).toContain(w);
    expect(Object.keys(APP_WRITES).sort()).toEqual(["CLICKUP_CREATE_TASK", "CLICKUP_UPDATE_TASK", "GMAIL_REPLY_TO_THREAD", "GMAIL_SEND_EMAIL", "SLACK_SEND_MESSAGE"]);
    expect(new Set(APP_ACTIONS.map(toolkitOf))).toEqual(new Set(["clickup", "slack", "gmail"]));
  });
});

/** The Mac surface's brain side, faked: records which app it was asked about and every call. */
class FakeMacApps extends FakeExecutor {
  log: string[] = [];
  app = "Front";
  failAct: string | null = null;
  constructor() {
    super([el("e0", { tag: "ax", role: "row", text: "general" }), el("e1", { tag: "ax", role: "text area", label: "Message" }), el("e2", { tag: "ax", role: "button", text: "Delete" })], "mac");
  }
  private stateOf(app: string | null) {
    if (app) this.app = app;
    return { snapshot: { url: `app://${this.app}`, title: this.app, elements: this.elements }, text: "Xander: ship it today", menus: ["File", "Edit"], app: this.app };
  }
  async readApp(app: string | null) {
    this.log.push(`read:${app}`);
    return this.stateOf(app);
  }
  async reread() {
    this.log.push(`reread:${this.app}`);
    return this.stateOf(null);
  }
  async actInApp(action: import("../core/actions.js").Action) {
    if (this.failAct) throw new Error(this.failAct);
    this.log.push(`act:${action.kind}`);
    return `did ${action.kind}`;
  }
  async menu(p: string[]) {
    this.log.push(`menu:${p.join(">")}`);
    return `Chose ${p.join(" › ")}`;
  }
  async setValue(id: string, _label: string, value: string) {
    this.log.push(`set:${id}=${value}`);
    return "set";
  }
  async clickText(text: string) {
    this.log.push(`clickText:${text}`);
    return `Clicked "${text}"`;
  }
  async launch(name: string) {
    this.log.push(`launch:${name}`);
    return `Opened ${name} in the background`;
  }
  async captureTo(file: string) {
    this.log.push(`shot:${path.basename(file)}`);
  }
}

describe("Mac apps in the background", () => {
  it("reads the app it is told to, not the one in front, and shows the window's text", async () => {
    const mac = new FakeMacApps();
    const { hands: h } = hands({ mac });
    const model = scripted([call("mac_read", { app: "Slack" }), say("Xander said ship it.")]);
    await collect(await brainWith(model, h).send("what did I miss in Slack"));
    expect(mac.log).toEqual(["read:Slack"]);
    const result = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    expect(result).toContain("Xander: ship it today");
    expect(result).toContain("App menus");
  });

  it("opens an app in the background instead of bringing it forward", async () => {
    const mac = new FakeMacApps();
    const { hands: h, opened } = hands({ mac });
    const model = scripted([call("mac_act", { action: "open_app", name: "Slack" }), say("ok")]);
    await collect(await brainWith(model, h).send("open slack and check it"));
    expect(mac.log).toEqual(["launch:Slack"]);
    expect(opened).toEqual([]); // not `open -a`, which fronts it
  });

  it("acts in the background and hands back the window it left, in the same step", async () => {
    const mac = new FakeMacApps();
    const { hands: h } = hands({ mac });
    const model = scripted([call("mac_read", { app: "Slack" }), call("mac_act", { action: "click", element_id: "e0" }), say("done")]);
    await collect(await brainWith(model, h).send("open general in slack"));
    expect(mac.log).toEqual(["read:Slack", "act:click", "shot:01-click.png", "reread:Slack"]);
    expect(JSON.stringify(model.doGenerateCalls[2]!.prompt)).toContain("Now:");
  });

  it("asks before a menu item that deletes, and not before a harmless one", async () => {
    const mac = new FakeMacApps();
    const { hands: h } = hands({ mac });
    const model = scripted([call("mac_read", { app: "Notes" }), call("mac_act", { action: "menu", path: ["File", "New Note"] }), call("mac_act", { action: "menu", path: ["Edit", "Delete"] }), say("ok")]);
    const brain = brainWith(model, h);
    const asked: string[] = [];
    await collect(await brain.send("tidy notes"), (e) => {
      if (e.kind === "approval") {
        asked.push(e.summary);
        void brain.approve([...(brain as unknown as { runs: Map<string, unknown> }).runs.keys()][0]!, "deny", e.requestId);
      }
    });
    expect(asked).toEqual(["choose Edit › Delete in Notes"]);
    expect(mac.log.filter((l) => l.startsWith("menu:"))).toEqual(["menu:File>New Note"]);
  });

  it("opens a row that has no id by its text — Slack's DM list is only text", async () => {
    // Live, 2026-09-25: "check Slack" saw five unread DMs and could open none of them, because each
    // row is static text inside a list with nothing to press.
    const mac = new FakeMacApps();
    const { hands: h } = hands({ mac });
    const model = scripted([call("mac_read", { app: "Slack" }), call("mac_act", { action: "click", text: "Abdul" }), say("ok")]);
    await collect(await brainWith(model, h).send("what did Abdul say"));
    expect(mac.log).toEqual(["read:Slack", "clickText:Abdul", "shot:01-click.png", "reread:Slack"]);
  });

  it("asks before clicking text that names a write", async () => {
    const mac = new FakeMacApps();
    const { hands: h } = hands({ mac });
    const model = scripted([call("mac_read", { app: "Mail" }), call("mac_act", { action: "click", text: "Delete all" }), say("ok")]);
    const brain = brainWith(model, h);
    const asked: string[] = [];
    await collect(await brain.send("clean up"), (e) => {
      if (e.kind === "approval") {
        asked.push(e.summary);
        void brain.approve([...(brain as unknown as { runs: Map<string, unknown> }).runs.keys()][0]!, "deny", e.requestId);
      }
    });
    expect(asked).toEqual(['click "Delete all" in Mail']);
    expect(mac.log).not.toContain("clickText:Delete all");
  });

  it("won't click a web link in an app — it would open his browser in front", async () => {
    const mac = new FakeMacApps();
    mac.elements.push(el("e3", { tag: "ax", role: "link", text: "Verifully.com" }), el("e4", { tag: "ax", role: "link", text: "#general" }));
    const { hands: h } = hands({ mac });
    const model = scripted([call("mac_read", { app: "Slack" }), call("mac_act", { action: "click", element_id: "e3" }), call("mac_act", { action: "click", element_id: "e4" }), say("ok")]);
    await collect(await brainWith(model, h).send("check slack"));
    expect(JSON.stringify(model.doGenerateCalls[2]!.prompt)).toContain("opens a web page in the user's browser");
    expect(mac.log.filter((l) => l.startsWith("act:"))).toEqual(["act:click"]); // only #general
  });

  it("recognises a web address, not an in-app link", () => {
    for (const yes of ["Verifully.com", "https://x.io/a", "www.instantly.ai", "docs.google.com/d/1"]) expect(opensBrowser(yes), yes).toBe(true);
    for (const no of ["#general", "Lena Hartwell", "@Dan", "v1.2 notes"]) expect(opensBrowser(no), no).toBe(false);
  });

  it("set puts the value on the element it read", async () => {
    const mac = new FakeMacApps();
    const { hands: h } = hands({ mac });
    const model = scripted([call("mac_read", { app: "Calendar" }), call("mac_act", { action: "set", element_id: "e1", value: "Friday" }), say("ok")]);
    await collect(await brainWith(model, h).send("set it to friday"));
    expect(mac.log).toContain("set:e1=Friday");
  });

  it("keeps a numbered screenshot of what each Mac action left behind, and the log names the folder", async () => {
    const mac = new FakeMacApps();
    const { hands: h } = hands({ mac });
    const dir = mkdtempSync(path.join(tmpdir(), "jev-runs-"));
    const model = scripted([call("mac_read", { app: "Slack" }), call("mac_act", { action: "click", element_id: "e0" }), call("mac_act", { action: "menu", path: ["File", "New"] }), say("ok")]);
    const run = await brainWith(model, h, {}, fileRunLog(dir)).send("go");
    await collect(run);
    expect(mac.log.filter((l) => l.startsWith("shot:"))).toEqual(["shot:01-click.png", "shot:02-menu.png"]);
    const day = readdirSync(dir)[0]!;
    const endLine = readFileSync(path.join(dir, day, `${run.id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "end");
    expect(endLine.recording).toBe(path.join(dir, day, run.id));
  });

  it("does not record a run that never touches the Mac", async () => {
    const mac = new FakeMacApps();
    const { hands: h } = hands({ mac });
    await collect(await brainWith(scripted([say("hi")]), h).send("hi"));
    expect(mac.log).toEqual([]);
  });
});

describe("Chrome in the background", () => {
  it("works in Jev's own window by default, and in his tab only when asked", async () => {
    const background = new FakeExecutor([el("e0", { tag: "a", text: "Inbox" })], "chrome-jev");
    const { hands: h, chrome } = hands({ chromeBackground: background });
    const model = scripted([call("chrome", { action: "navigate", url: "mail.google.com" }), call("chrome", { action: "read_text" }), call("chrome", { action: "read_text", tab: "his_tab" }), say("ok")]);
    await collect(await brainWith(model, h).send("newest email subject"));
    expect(background.executed).toEqual([{ kind: "navigate", url: "https://mail.google.com" }]);
    expect(chrome.executed).toEqual([]);
  });

  it("does not act on an id read from the other tab", async () => {
    const background = new FakeExecutor([el("e0", { tag: "a", text: "Inbox" })], "chrome-jev");
    const { hands: h, chrome } = hands({ chromeBackground: background });
    const model = scripted([call("chrome", { action: "read_elements", tab: "his_tab" }), call("chrome", { action: "click", element_id: "e1" }), say("ok")]);
    await collect(await brainWith(model, h).send("click general"));
    expect(background.executed).toEqual([]);
    expect(chrome.executed).toEqual([]);
    expect(JSON.stringify(model.doGenerateCalls[2]!.prompt)).toContain("Read first");
  });
});

describe("never the same message twice in one run", () => {
  it("refuses the second send of the same words — the DM-then-#all-agents case — without asking", async () => {
    // Live 2026-09-25: " where are you located?" went to the Revenue Agent DM, then again to
    // #all-agents. the user approved both prompts; he wanted one message.
    const mac = new FakeMacApps();
    const { hands: h } = hands({ mac });
    const model = scripted([
      call("mac_read", { app: "Slack" }),
      call("mac_act", { action: "type", element_id: "e1", text: " where are you located?", submit: true }),
      call("mac_act", { action: "type", element_id: "e1", text: "@revenueagent Where are you located?", submit: true }),
      say("sent once"),
    ]);
    const brain = brainWith(model, h);
    const asked: string[] = [];
    await collect(await brain.send("ask revenue agent where it is"), (e) => {
      if (e.kind === "approval") {
        asked.push(e.summary);
        void brain.approve([...(brain as unknown as { runs: Map<string, unknown> }).runs.keys()][0]!, "once", e.requestId);
      }
    });
    expect(asked).toHaveLength(1);
    expect(mac.log.filter((l) => l === "act:type")).toHaveLength(1);
    expect(JSON.stringify(model.doGenerateCalls[3]!.prompt)).toContain("Already sent");
  });
});

describe("each step resends less", () => {
  it("older screens reach the model shortened; the latest stay whole", async () => {
    const mac = new FakeMacApps();
    const { hands: h } = hands({ mac });
    const model = scripted([call("mac_read", { app: "Slack" }), call("mac_read", { app: "Slack" }), call("mac_read", { app: "Slack" }), say("done")]);
    await collect(await brainWith(model, h).send("check slack"));
    const last = JSON.stringify(model.doGenerateCalls[3]!.prompt);
    expect(last.match(/older screen, shortened/g)).toHaveLength(1); // the first of three reads
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).not.toContain("shortened"); // one read: untouched
  });
});

/** The co-founder, faked at the Cofounder seam (the Orgo transport has its own tests). */
class FakeCofounder {
  sent: Array<{ message: string; id: string }> = [];
  watched: string[] = [];
  reply: { state: string; result: string } = { state: "complete", result: "I'm on Orgo 00000000." };
  async send(message: string, id: string) {
    this.sent.push({ message, id });
    return { id, ...this.reply };
  }
  watch(id: string) {
    this.watched.push(id);
  }
}

describe("the co-founder tool", () => {
  const approveAll = (brain: AgentBrain, asked: string[], choice: "once" | "deny" = "once") => (e: BrainEvent) => {
    if (e.kind === "approval") {
      asked.push(e.summary);
      void brain.approve([...(brain as unknown as { runs: Map<string, unknown> }).runs.keys()][0]!, choice, e.requestId);
    }
  };

  it("asks, hands the task over, and brings the reply back", async () => {
    const co = new FakeCofounder();
    const { hands: h } = hands({ cofounder: co as never });
    const model = scripted([call("cofounder", { message: "Where are you running?" }), say("It's on Orgo.")]);
    const brain = brainWith(model, h);
    const asked: string[] = [];
    await collect(await brain.send("ask the co-founder where it's running"), approveAll(brain, asked));
    expect(asked).toEqual(['hand this to the co-founder: "Where are you running?"']);
    expect(co.sent.map((s) => s.message)).toEqual(["Where are you running?"]);
    expect(co.sent[0]!.id).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("I'm on Orgo 00000000.");
  });

  it("a slow task is handed off and watched, and the brain is told not to wait", async () => {
    const co = new FakeCofounder();
    co.reply = { state: "running", result: "" };
    const { hands: h } = hands({ cofounder: co as never });
    const model = scripted([call("cofounder", { message: "Research our top 3 competitors" }), say("Handed off.")]);
    const brain = brainWith(model, h);
    await collect(await brain.send("have the co-founder research competitors"), approveAll(brain, []));
    expect(co.watched).toEqual([co.sent[0]!.id]);
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("don't wait for it");
  });

  it("sends nothing when the user says no, and says so plainly when it isn't connected", async () => {
    const co = new FakeCofounder();
    const { hands: h } = hands({ cofounder: co as never });
    const model = scripted([call("cofounder", { message: "Delete the old projects" }), say("ok")]);
    const brain = brainWith(model, h);
    await collect(await brain.send("tell the co-founder to delete old projects"), approveAll(brain, [], "deny"));
    expect(co.sent).toEqual([]);

    const { hands: off } = hands();
    const m2 = scripted([call("cofounder", { message: "hi" }), say("not connected")]);
    await collect(await brainWith(m2, off).send("ask the co-founder hi"));
    expect(JSON.stringify(m2.doGenerateCalls[1]!.prompt)).toContain("ORGO_API_KEY");
  });

  it("a retry of the same hand-off in one run is refused rather than sent as a second task", async () => {
    const co = new FakeCofounder();
    const { hands: h } = hands({ cofounder: co as never });
    const model = scripted([call("cofounder", { message: "Where are you running?" }), call("cofounder", { message: "where are you running?" }), say("done")]);
    const brain = brainWith(model, h);
    await collect(await brain.send("ask it twice"), approveAll(brain, []));
    expect(co.sent).toHaveLength(1);
  });
});
