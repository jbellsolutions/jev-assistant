import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { BrainEvent, BrainRun } from "../core/brain.js";
import { AgentBrain } from "../server/brain/agent.js";
import { LeadBrain, jobBrief, jobStatus } from "../server/brain/lead.js";
import { fileRunLog } from "../server/brain/runlog.js";
import { TaskStore } from "../server/brain/task-store.js";
import type { Hands } from "../server/brain/tools.js";
import { FakeExecutor, el } from "./helpers/fake-executor.js";

type GenResult = ConstructorParameters<typeof MockLanguageModelV4>[0] extends infer O ? (O extends { doGenerate?: infer G } ? Exclude<G, Function | unknown[]> : never) : never;
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
let seq = 0;
const say = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] }) as unknown as GenResult;
const call = (toolName: string, input: unknown) =>
  ({ content: [{ type: "tool-call" as const, toolCallId: `c${++seq}`, toolName, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] }) as unknown as GenResult;

/** Answers from a script, one entry per call; the last entry repeats. */
function scripted(steps: GenResult[], onCall?: (n: number) => void) {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      onCall?.(i);
      return steps[Math.min(i++, steps.length - 1)]!;
    },
  });
}

async function collect(run: BrainRun, onEvent?: (e: BrainEvent) => void): Promise<BrainEvent[]> {
  const seen: BrainEvent[] = [];
  for await (const e of run.events) {
    seen.push(e);
    onEvent?.(e);
  }
  return seen;
}

function setup(leadSteps: GenResult[], workerModel: MockLanguageModelV4, tasks = new TaskStore(null)) {
  const chrome = new FakeExecutor([el("e0", { tag: "button", text: "New External Client App", label: "New External Client App" })], "chrome");
  const hands = { chrome, chromeBackground: chrome, mac: null, computer: null } as Hands;
  const log = fileRunLog(mkdtempSync(path.join(tmpdir(), "jev-lead-")));
  const worker = new AgentBrain({ model: workerModel, modelId: "test/worker", hands, instructions: () => "You are the worker.", log });
  const leadModel = scripted(leadSteps);
  const lead = new LeadBrain({ model: leadModel, modelId: "test/lead", worker, tasks, log, limits: { sayGapMs: 0 } });
  return { lead, leadModel, worker, tasks };
}

const systemOf = (m: MockLanguageModelV4, n: number) => JSON.stringify(m.doGenerateCalls[n]!.prompt.filter((p) => p.role === "system"));

describe("the lead plans, the worker works (v11.5)", () => {
  it("speaks a plan, runs jobs, carries what job 1 learned into job 2, and closes the task", async () => {
    const workerModel = scripted([say("STATUS: done\nLogged in. Setup is at https://example-tenant-123.my.salesforce.com/lightning/setup/ManageExternalClientApplication/home")]);
    const { lead, tasks } = setup(
      [
        call("say", { text: "Logging into Salesforce to make the app — I'll tell you when the keys are in place." }),
        call("work", { goal: "Log into Salesforce and open External Client App Manager", done_when: "The manager page is showing" }),
        call("note", { key: "setup_url", value: "https://example-tenant-123.my.salesforce.com/lightning/setup/ManageExternalClientApplication/home" }),
        call("work", { goal: "Create a new External Client App named Lead Sync", done_when: "The new app's page is showing" }),
        call("finish", { outcome: "done" }),
        say("Done — Lead Sync is created."),
      ],
      workerModel,
    );
    const events = await collect(await lead.send("log into salesforce and make an external client app called Lead Sync"));
    expect(events.find((e) => e.kind === "say")).toEqual({ kind: "say", text: "Logging into Salesforce to make the app — I'll tell you when the keys are in place." });
    expect(events.at(-1)).toEqual({ kind: "completed", output: "Done — Lead Sync is created." });
    // job 2 was told what job 1 found, and that it is one job for the lead
    const job2 = systemOf(workerModel, 1);
    expect(job2).toContain("THIS RUN IS ONE JOB FOR JEV'S LEAD");
    expect(job2).toContain("setup_url: https://example-tenant-123.my.salesforce.com");
    expect(job2).toContain("Never type a value you were not given");
    expect(tasks.current).toBeNull(); // finished
  });

  it("keeps the task open across turns: a follow-up sees the jobs and facts so far", async () => {
    const workerModel = scripted([say("STATUS: needs_input\nThe form needs a contact email.")]);
    const { lead, leadModel, tasks } = setup(
      [call("work", { goal: "Fill the new app form", done_when: "Form submitted" }), say("What contact email should the app use?"), say("Got it — carrying on.")],
      workerModel,
    );
    await collect(await lead.send("make the salesforce app"));
    expect(tasks.current?.jobs.map((j) => j.status)).toEqual(["needs_input"]);
    await collect(await lead.send("use justin@example.com"));
    const second = systemOf(leadModel, leadModel.doGenerateCalls.length - 1);
    expect(second).toContain("Open task");
    expect(second).toContain("[needs_input] Fill the new app form");
  });

  it("passes the worker's approval questions through, and the answer back to the job that asked", async () => {
    const workerModel = scripted([call("shell", { command: "rm -rf ~/scratch" }), say("STATUS: blocked\nthe user said no.")]);
    const { lead } = setup([call("work", { goal: "Clean the scratch folder", done_when: "It is empty" }), say("He said no, so I left it.")], workerModel);
    const run = await lead.send("clean my scratch folder");
    const events = await collect(run, (e) => {
      if (e.kind === "approval") void lead.approve(run.id, "deny", e.requestId);
    });
    expect(events.some((e) => e.kind === "approval")).toBe(true);
    expect(events.some((e) => e.kind === "approved")).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "completed", output: "He said no, so I left it." });
  });

  it("a nudge mid-job ends the job at its next step and the lead reads it before going on", async () => {
    let lead!: LeadBrain;
    let runId = "";
    // the worker keeps working until the nudge lands, on its second step
    const workerModel = scripted([call("chrome", { action: "read_elements" }), call("chrome", { action: "read_elements" })], (n) => {
      if (n === 1) void lead.steer(runId, "you're on the right page — create a new one, don't edit the old one");
    });
    const s = setup([call("work", { goal: "Open the app manager", done_when: "Manager showing" }), say("Creating a new one, as you said.")], workerModel);
    lead = s.lead;
    const run = await lead.send("make the salesforce app");
    runId = run.id;
    await collect(run);
    expect(s.tasks.current?.jobs.at(-1)?.status).toBe("interrupted");
    const after = systemOf(s.leadModel, 1);
    expect(after).toContain("create a new one, don't edit the old one");
  });

  it("a co-founder request through the lead: the worker has no cofounder tool and can't open the user's secrets", async () => {
    const workerModel = scripted([call("chrome", { action: "read_elements" }), call("chrome", { action: "type", element_id: "e0", text: "{{secret:s1}}" }), say("STATUS: blocked\nno")]);
    const s = setup([call("work", { goal: "Paste the key", done_when: "pasted" }), say("Couldn't.")], workerModel);
    s.worker.secrets.mask("api key TEST_ONLY_SALESFORCE_KEY_DO_NOT_USE_1234567890");
    await collect(await s.lead.send("paste the user's key", { from: "cofounder" }));
    expect(workerModel.doGenerateCalls[0]!.tools?.map((t) => t.name)).not.toContain("cofounder");
    expect(JSON.stringify(workerModel.doGenerateCalls[2]!.prompt)).toContain("aren't available to requests from the co-founder");
  });

  it("a task this turn opened and fully did closes itself even without finish; one waiting on the user stays open", async () => {
    const done = setup([call("work", { goal: "Read HN", done_when: "read" }), say("The top story is X.")], scripted([say("STATUS: done\nX")]));
    await collect(await done.lead.send("what's the top story on HN?"));
    expect(done.tasks.current).toBeNull();
    const asking = setup([call("work", { goal: "Open the form", done_when: "open" }), say("What should the app be called?")], scripted([say("STATUS: done\nopen")]));
    await collect(await asking.lead.send("make the salesforce app"));
    expect(asking.tasks.current).not.toBeNull();
    const blocked = setup([call("work", { goal: "Fill it", done_when: "filled" }), say("It needs your email.")], scripted([say("STATUS: needs_input\nemail")]));
    await collect(await blocked.lead.send("fill the form"));
    expect(blocked.tasks.current).not.toBeNull();
  });

  it("work's say field is spoken as the job starts, before the worker's first tool", async () => {
    const workerModel = scripted([call("chrome", { action: "read_elements" }), say("STATUS: done\nok")]);
    const { lead } = setup([call("work", { goal: "Open Setup", done_when: "open", say: "Opening Salesforce Setup now." }), say("Done.")], workerModel);
    const events = await collect(await lead.send("open salesforce setup"));
    const kinds = events.map((e) => (e.kind === "say" ? `say:${e.text}` : e.kind));
    expect(kinds.indexOf("say:Opening Salesforce Setup now.")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("say:Opening Salesforce Setup now.")).toBeLessThan(kinds.indexOf("tool_start"));
  });

  it("Stop ends the lead and the job it is waiting on", async () => {
    const hang = new MockLanguageModelV4({
      doGenerate: (opts) => new Promise((_r, reject) => opts.abortSignal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })),
    });
    const { lead } = setup([call("work", { goal: "Something slow", done_when: "never" })], hang);
    const run = await lead.send("do the slow thing");
    setTimeout(() => void lead.stop(run.id), 30);
    const events = await collect(run);
    expect(events.at(-1)).toEqual({ kind: "cancelled" });
  });

  it("stops handing out jobs past the turn's budget", async () => {
    const workerModel = scripted([say("STATUS: done\nok")]);
    const s = setup([call("work", { goal: "again", done_when: "done" })], workerModel);
    const lead = new LeadBrain({ model: scripted([call("work", { goal: "a", done_when: "b" }), call("work", { goal: "a2", done_when: "b" }), call("work", { goal: "a3", done_when: "b" }), say("Paused.")]), modelId: "t", worker: s.worker, tasks: new TaskStore(null), limits: { maxJobs: 2 } });
    await collect(await lead.send("go"));
    expect(workerModel.doGenerateCalls).toHaveLength(2);
  });
});

describe("job reports and briefs", () => {
  it("reads the worker's STATUS line, and a step-limit stop is never 'done' unless it said so", () => {
    expect(jobStatus({ reason: "answered", output: "STATUS: needs_input\nNeed the email", steps: 3 })).toBe("needs_input");
    expect(jobStatus({ reason: "wrapped_up", output: "I got to the form.", steps: 25 })).toBe("step_limit");
    expect(jobStatus({ reason: "wrapped_up", output: "STATUS: done — created", steps: 25 })).toBe("done");
    expect(jobStatus({ reason: "interrupted", output: "", steps: 2 })).toBe("interrupted");
    expect(jobStatus({ reason: "failed", output: "boom", steps: 1 })).toBe("failed");
  });

  it("keeps the worker in its own window unless the user asked for his tab", () => {
    expect(jobBrief({ goal: "x", doneWhen: "y" }, null)).toContain("Do not use his_tab");
    expect(jobBrief({ goal: "x", doneWhen: "y", tab: "his_tab" }, null)).toContain("tab: his_tab");
  });
});

describe("the task survives a restart", () => {
  it("reloads the open task with its facts, hosts and jobs, and archives it when closed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jev-task-"));
    const a = new TaskStore(dir);
    a.open("make the salesforce app");
    a.note("org_host", "example-tenant-123.my.salesforce.com");
    a.sawHost("example-tenant-123.my.salesforce.com");
    a.addJob("log in", "done", "logged in");
    const b = new TaskStore(dir);
    expect(b.current?.facts.org_host).toBe("example-tenant-123.my.salesforce.com");
    expect(b.current?.hosts).toEqual(["example-tenant-123.my.salesforce.com"]);
    expect(b.brief()).toContain("[done] log in");
    b.close("done");
    expect(new TaskStore(dir).current).toBeNull();
  });
});
