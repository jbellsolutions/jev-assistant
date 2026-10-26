import { describe, expect, it } from "vitest";
import { HeuristicDecider } from "../core/decide.js";
import { type Control, describeControl, lineKey } from "../core/controls.js";
import { TimerStore } from "../core/timers.js";
import { LINES, withoutTags } from "../core/lines.js";
import type { PageElement } from "../core/elements.js";
import type { ServerMessage } from "../core/protocol.js";
import { isSleepCommand } from "../core/route.js";
import { Session, isQuestion, wantsAnswer } from "../core/session.js";
import { FakeBrain, tick, waitFor } from "./helpers/fake-brain.js";
import { FakeExecutor, el } from "./helpers/fake-executor.js";

function make(elements: PageElement[] = []) {
  const executor = new FakeExecutor(elements);
  const messages: ServerMessage[] = [];
  const session = new Session("fake", { executor, decider: new HeuristicDecider() });
  session.subscribe((m) => messages.push(m));
  const types = () => messages.map((m) => m.type);
  return { executor, session, messages, types };
}

describe("Session: single commands", () => {
  it("decides, executes and reports one step", async () => {
    const { session, executor, messages, types } = make();
    const r = await session.command("open wikipedia.org");
    expect(executor.executed).toEqual([{ kind: "navigate", url: "https://wikipedia.org" }]);
    expect(r.ok).toBe(true);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.decision?.intent).toBe("open_url");
    expect(r.steps[0]!.result).toEqual({ text: "did navigate", level: "ok" });
    expect(r.page.url).toBe("https://wikipedia.org");
    expect(types().slice(0, 5)).toEqual(["transcript_ack", "status", "decision", "status", "status"]);
    await new Promise((r) => setTimeout(r, 0)); // background verification lands after the command resolves
    expect(executor.snapshots).toBe(2);
    expect(messages.at(-1)).toMatchObject({ type: "verify", command: "open wikipedia.org", verify: { done: true, source: "code" } });
    expect(messages.find((m) => m.type === "decision")).toMatchObject({ decision: { intent: "open_url", source: "heuristic" } });
  });

  it("turns an executor error into an error result, never a rejection", async () => {
    const { session, executor } = make();
    executor.failNext = "boom";
    const r = await session.command("open wikipedia.org");
    expect(r.ok).toBe(false);
    expect(r.steps[0]!.result).toEqual({ text: "boom", level: "error" });
  });

  it("reports unrecognised speech as a warning without touching the executor", async () => {
    const { session, executor } = make();
    const r = await session.command("what do you think about that");
    expect(executor.executed).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.steps[0]!.result?.level).toBe("warn");
  });

  it("ignores empty input", async () => {
    const { session, executor, messages } = make();
    const r = await session.command("   ");
    expect(r.steps).toEqual([]);
    expect(executor.snapshots).toBe(0);
    expect(messages).toEqual([]);
  });
});

describe("Session: confirmation gate", () => {
  const risky = [el("e0", { tag: "button", text: "Delete account" })];

  it("holds a risky click until a spoken yes", async () => {
    const { session, executor, types } = make(risky);
    const first = await session.command("click delete account");
    expect(executor.executed).toEqual([]);
    expect(first.pending).toMatchObject({ kind: "confirm", actionLabel: 'Click button "Delete account"' });
    expect(types()).toContain("confirm");
    const second = await session.command("yes");
    expect(executor.executed).toEqual([{ kind: "click", elementId: "e0", label: 'button "Delete account"' }]);
    expect(second.ok).toBe(true);
    expect(second.pending).toBeNull();
  });

  it("cancels on a spoken no and on reply(false)", async () => {
    const a = make(risky);
    await a.session.command("click delete account");
    const r = await a.session.command("no");
    expect(a.executor.executed).toEqual([]);
    expect(r.steps[0]!.result).toMatchObject({ level: "warn", text: expect.stringContaining("Cancelled") });

    const b = make(risky);
    await b.session.command("click delete account");
    const r2 = await b.session.reply(false);
    expect(b.executor.executed).toEqual([]);
    expect(r2.pending).toBeNull();
  });

  it("runs the held action on reply(true)", async () => {
    const { session, executor } = make(risky);
    await session.command("click delete account");
    const r = await session.reply(true);
    expect(executor.executed).toHaveLength(1);
    expect(r.ok).toBe(true);
  });

  it("lets an unrelated command supersede the question", async () => {
    const { session, executor } = make(risky);
    await session.command("click delete account");
    const r = await session.command("scroll down");
    expect(executor.executed).toEqual([{ kind: "scroll", direction: "down" }]);
    expect(r.pending).toBeNull();
    expect(session.pending).toBeNull();
  });

  it("reply() with nothing pending is a no-op", async () => {
    const { session, executor } = make();
    const r = await session.reply(true);
    expect(executor.executed).toEqual([]);
    expect(r.ok).toBe(false);
  });
});

describe("Session: clarification", () => {
  const ambiguous = [el("e0", { text: "Pricing", hrefShort: "/pricing" }), el("e1", { text: "Pricing FAQ", hrefShort: "/faq" }), el("e2", { text: "Pricing plans", hrefShort: "/plans" })];

  it("asks which one and accepts an ordinal", async () => {
    const { session, executor, messages } = make(ambiguous);
    const first = await session.command("click pricing");
    expect(first.pending?.kind).toBe("clarify");
    const clarify = messages.find((m) => m.type === "clarify");
    expect(clarify && clarify.type === "clarify" ? clarify.options.length : 0).toBeGreaterThan(1);
    const second = await session.command("the second one");
    expect(executor.executed).toHaveLength(1);
    expect(executor.executed[0]).toMatchObject({ kind: "click" });
    expect(second.pending).toBeNull();
  });

  it("accepts a picked option id", async () => {
    const { session, executor } = make(ambiguous);
    await session.command("click pricing");
    const r = await session.pick("e1");
    expect(executor.executed).toEqual([{ kind: "click", elementId: "e1", label: 'link "Pricing FAQ" → /faq' }]);
    expect(r.ok).toBe(true);
  });

  it("treats a non-ordinal reply as a new command", async () => {
    const { session, executor } = make(ambiguous);
    await session.command("click pricing");
    await session.command("scroll down");
    expect(executor.executed).toEqual([{ kind: "scroll", direction: "down" }]);
  });
});

describe("Session: control", () => {
  it("cancel() clears a pending question without executing", async () => {
    const { session, executor, types } = make([el("e0", { tag: "button", text: "Delete account" })]);
    await session.command("click delete account");
    session.cancel();
    expect(session.pending).toBeNull();
    expect(types().at(-1)).toBe("status");
    const r = await session.reply(true);
    expect(executor.executed).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("serializes commands in order", async () => {
    const { session, executor } = make();
    await Promise.all([session.command("open a.com"), session.command("open b.com"), session.command("scroll down")]);
    expect(executor.executed.map((a) => a.kind)).toEqual(["navigate", "navigate", "scroll"]);
  });

  it("setViewport emits the new size and reports whether anything changed", async () => {
    const { session, messages } = make();
    expect(await session.setViewport(1280, 800)).toBe(false);
    expect(await session.setViewport(1000, 700)).toBe(true);
    expect(messages.at(-1)).toEqual({ type: "viewport", width: 1000, height: 700 });
  });

  it("status() describes the session", async () => {
    const { session } = make();
    expect(await session.status()).toMatchObject({ id: "fake", kind: "playwright", url: "https://example.test/", busy: false, pending: null });
  });
});

describe("Session: multi-step utterances", () => {
  const risky = [el("e0", { tag: "button", text: "Delete account" })];
  const ambiguous = [el("e0", { text: "Pricing", hrefShort: "/pricing" }), el("e1", { text: "Pricing FAQ", hrefShort: "/faq" }), el("e2", { text: "Pricing plans", hrefShort: "/plans" })];

  it("runs each step against a fresh snapshot and announces the split", async () => {
    const { session, executor, messages } = make();
    const r = await session.command("open a.com and then open b.com and scroll down");
    expect(executor.snapshots).toBe(7); // one to route the whole utterance, then one before and one after each step
    expect(executor.executed.map((a) => a.kind)).toEqual(["navigate", "navigate", "scroll"]);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.command)).toEqual(["open a.com", "open b.com", "scroll down"]);
    expect(r.steps.map((s) => s.verify?.text)).toEqual(["done", "done", "done"]);
    expect(r.stoppedAt).toBeUndefined();
    expect(messages[0]).toEqual({ type: "steps", original: "open a.com and then open b.com and scroll down", commands: ["open a.com", "open b.com", "scroll down"] });
    const acks = messages.filter((m) => m.type === "transcript_ack");
    expect(acks).toHaveLength(3);
    expect(acks[1]).toMatchObject({ text: "open b.com", step: { index: 1, total: 3 } });
  });

  it("a single-step utterance carries no step info and no steps message", async () => {
    const { session, messages } = make();
    await session.command("open a.com");
    expect(messages.some((m) => m.type === "steps")).toBe(false);
    expect(messages[0]).toEqual({ type: "transcript_ack", text: "open a.com", stepId: 1 });
  });

  it("stops the sequence when a step fails", async () => {
    const { session, executor, messages } = make();
    executor.failNext = "network down";
    const r = await session.command("open a.com and scroll down");
    expect(executor.executed).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.stoppedAt).toBe(0);
    expect(r.steps).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ type: "status", level: "warn", text: expect.stringContaining("Stopped after step 1 of 2") });
  });

  it("stops when a step is not a browser command", async () => {
    const { session, executor } = make();
    const r = await session.command("open a.com and what do you think and scroll down");
    // "what do you think" has no verb so it stays glued to step 1; only the scroll splits off
    expect(r.steps.map((s) => s.command)).toEqual(["open a.com and what do you think", "scroll down"]);
    expect(executor.executed.map((a) => a.kind)).toEqual(["navigate", "scroll"]);
  });

  it("parks the remaining steps behind a confirmation and resumes on yes", async () => {
    const { session, executor } = make(risky);
    const first = await session.command("click delete account and scroll down");
    expect(first.pending?.kind).toBe("confirm");
    expect(first.stoppedAt).toBe(0);
    expect(executor.executed).toEqual([]);
    const second = await session.command("yes");
    expect(executor.executed.map((a) => a.kind)).toEqual(["click", "scroll"]);
    expect(second.ok).toBe(true);
    expect(second.steps.map((s) => s.command)).toEqual(["yes", "scroll down"]);
  });

  it("drops the remaining steps on no", async () => {
    const { session, executor } = make(risky);
    await session.command("click delete account and scroll down");
    await session.command("no");
    expect(executor.executed).toEqual([]);
    await session.command("open a.com");
    expect(executor.executed.map((a) => a.kind)).toEqual(["navigate"]);
  });

  it("resumes after reply(true) and after pick()", async () => {
    const a = make(risky);
    await a.session.command("click delete account and scroll down");
    await a.session.reply(true);
    expect(a.executor.executed.map((x) => x.kind)).toEqual(["click", "scroll"]);

    const b = make(ambiguous);
    await b.session.command("click pricing and scroll down");
    await b.session.pick("e2");
    expect(b.executor.executed.map((x) => x.kind)).toEqual(["click", "scroll"]);

    const c = make(ambiguous);
    await c.session.command("click pricing and scroll down");
    await c.session.command("the third one");
    expect(c.executor.executed.map((x) => x.kind)).toEqual(["click", "scroll"]);
  });

  it("an unrelated command while a question is open drops the parked steps too", async () => {
    const { session, executor } = make(risky);
    await session.command("click delete account and scroll down");
    await session.command("open c.com");
    expect(executor.executed).toEqual([{ kind: "navigate", url: "https://c.com" }]);
    expect(session.pending).toBeNull();
  });

  it("cancel() drops parked steps", async () => {
    const { session, executor } = make(risky);
    await session.command("click delete account and scroll down");
    session.cancel();
    await session.reply(true);
    expect(executor.executed).toEqual([]);
  });

  it("'stop' as a step ends the sequence", async () => {
    const { session, executor } = make();
    const r = await session.command("open a.com and stop and open b.com");
    expect(executor.executed.map((a) => a.kind)).toEqual(["navigate"]);
    expect(r.steps).toHaveLength(2);
  });
});

describe("Session: verification in sequences", () => {
  it("stops the sequence when a step is stuck, naming the blocker", async () => {
    const { session, executor, messages } = make([el("e0", { tag: "button", text: "Next" })]);
    executor.clickChangesPage = false; // a dead click: no diff → heuristic says stuck
    const r = await session.command("click next and scroll down");
    expect(executor.executed.map((a) => a.kind)).toEqual(["click"]);
    expect(r.ok).toBe(false);
    expect(r.stoppedAt).toBe(0);
    expect(r.steps[0]!.verify).toMatchObject({ stuck: true, blocker: "no_change", source: "heuristic" });
    expect(messages.at(-1)).toMatchObject({ type: "status", level: "warn", text: "Stopped after step 1 of 2: stuck: no change" });
  });

  it("a single stuck command is reported but not treated as a sequence failure", async () => {
    const { session, executor } = make([el("e0", { tag: "button", text: "Next" })]);
    executor.clickChangesPage = false;
    const r = await session.command("click next");
    expect(executor.executed).toHaveLength(1);
    expect(r.ok).toBe(true);
    expect(r.stoppedAt).toBeUndefined();
  });

  it("verify: off skips the after-snapshot entirely", async () => {
    const executor = new FakeExecutor();
    const session = new Session("fake", { executor, decider: new HeuristicDecider(), verify: "off" });
    const r = await session.command("open a.com and scroll down");
    expect(executor.snapshots).toBe(3); // route + one per step
    expect(r.steps.every((s) => s.verify === undefined)).toBe(true);
  });
});

describe("Session: held actions are verified too", () => {
  it("a resumed sequence stops when the confirmed click turns out to be stuck", async () => {
    const { session, executor } = make([el("e0", { tag: "button", text: "Delete account" })]);
    executor.clickChangesPage = false;
    await session.command("click delete account and scroll down");
    const r = await session.command("yes");
    expect(executor.executed.map((a) => a.kind)).toEqual(["click"]);
    expect(r.ok).toBe(false);
    expect(r.steps[0]!.verify).toMatchObject({ stuck: true });
  });

  it("a confirmed click that changes the page continues the sequence", async () => {
    const { session, executor } = make([el("e0", { tag: "button", text: "Delete account" })]);
    await session.command("click delete account and scroll down");
    const r = await session.reply(true);
    expect(executor.executed.map((a) => a.kind)).toEqual(["click", "scroll"]);
    expect(r.steps[0]!.verify).toMatchObject({ done: true });
  });
});

describe("Session: brain lane (Hermes)", () => {
  function withBrain(opts: { computer?: boolean; files?: Record<string, string[]>; noControls?: boolean } = {}) {
    const executor = new FakeExecutor([el("e0", { text: "Pricing", hrefShort: "/pricing" })]);
    const brain = new FakeBrain();
    const opened: string[] = [];
    const controls: Control[] = [];
    const computer = opts.computer
      ? {
          openApp: async (app: string) => { opened.push(app); return `Opened ${app}`; },
          findFiles: async (q: string) => (opts.files ?? {})[q] ?? [],
          openPath: async (p: string) => { opened.push(p); return `Opened ${p.split("/").pop()}`; },
          ...(opts.noControls ? {} : { control: async (c: Control) => { controls.push(c); opened.push(`control:${lineKey(c)}`); return describeControl(c); } }),
        }
      : null;
    const messages: ServerMessage[] = [];
    const session = new Session("fake", { executor, decider: new HeuristicDecider(), brain, computer, retryDelayMs: 1 });
    session.subscribe((m) => messages.push(m));
    const brainEvents = () => messages.filter((m): m is Extract<ServerMessage, { type: "brain_event" }> => m.type === "brain_event").map((m) => m.event.kind);
    return { executor, brain, opened, controls, session, messages, brainEvents };
  }

  it("an instant action the user asked for goes into the brain's chat; the API's don't, nor brain turns", async () => {
    const { session, brain } = withBrain({ computer: true });
    await session.command("open slack", { speak: true });
    expect(brain.remembered).toEqual([{ user: "open slack", outcome: expect.stringContaining("Opened slack") }]);
    await session.command("open notes", { local: true });
    expect(brain.remembered).toHaveLength(1);
    const asked = session.command("what's the weather", { speak: true });
    await tick();
    brain.emit("run_1", { kind: "completed", output: "Sunny." }, null);
    await asked;
    expect(brain.remembered).toHaveLength(1);
  });

  describe("requests from the co-founder (over the tailnet)", () => {
    it("are labelled, and their approvals say whose they are and are asked aloud", async () => {
      const spoken: string[] = [];
      const brain = new FakeBrain();
      const session = new Session("co", { executor: new FakeExecutor([]), decider: new HeuristicDecider(), brain, computer: null, retryDelayMs: 1, speaker: { speak: async (t: string) => void spoken.push(t), stop: () => {}, maxChars: 600 } });
      const messages: ServerMessage[] = [];
      session.subscribe((m) => messages.push(m));
      const asked = session.fromCofounder("what's the weather in Austin?");
      await tick();
      expect(messages).toContainEqual(expect.objectContaining({ type: "transcript_ack", text: expect.stringMatching(/^🤝 From the co-founder: what.s the weather in austin/i) }));
      brain.emit("run_1", { kind: "approval", requestId: "a1", summary: "send a Slack message", choices: ["once", "deny"] });
      await tick();
      expect(spoken.join(" ")).toMatch(/send a Slack message \(the co-founder asked\)/);
      brain.emit("run_1", { kind: "completed", output: "Sunny." }, null);
      expect((await asked).output).toBe("Sunny.");
      expect(brain.fromFlags).toEqual(["cofounder"]);
    });

    it("while its run works, the user's own words are his: not labelled theirs, never steered in", async () => {
      const brain = new FakeBrain();
      const session = new Session("co3", { executor: new FakeExecutor([el("e0", { text: "Pricing", hrefShort: "/pricing" })]), decider: new HeuristicDecider(), brain, computer: null, retryDelayMs: 1 });
      const messages: ServerMessage[] = [];
      session.subscribe((m) => messages.push(m));
      const theirs = session.fromCofounder("what's the weather in Austin?");
      await tick();
      await session.command("click pricing", { speak: true });
      const acks = messages.filter((m): m is Extract<ServerMessage, { type: "transcript_ack" }> => m.type === "transcript_ack");
      expect(acks.at(-1)!.text).toBe("click pricing");
      expect(brain.steers).toEqual([]);

      // and a question of his own stops theirs and runs as his
      const mine = session.command("what's on my calendar today", { speak: true });
      await waitFor(() => brain.sent.length === 2);
      expect(brain.stops).toEqual(["run_1"]);
      expect(brain.steers).toEqual([]);
      expect(brain.fromFlags).toEqual(["cofounder", undefined]);
      expect((await theirs).output).toMatch(/the user needed Jev/);
      brain.emit("run_2", { kind: "completed", output: "Two meetings." }, null);
      await mine;
    });

    it("never steer a run the user started", async () => {
      const brain = new FakeBrain();
      const session = new Session("co2", { executor: new FakeExecutor([]), decider: new HeuristicDecider(), brain, computer: null, retryDelayMs: 1 });
      void session.command("what's on my calendar today", { speak: true });
      await tick();
      const r = await session.fromCofounder("also delete my drafts");
      expect(r.output).toMatch(/busy with something for the user/);
      expect(brain.steers).toEqual([]);
      expect(brain.sent).toEqual(["what's on my calendar today"]);
    });
  });

  describe("talking to the co-founder directly", () => {
    function inMode() {
      const w = withBrain();
      let to: "jev" | "cofounder" = "jev";
      const passed: string[] = [];
      const session = new Session("fake2", {
        executor: w.executor,
        decider: new HeuristicDecider(),
        brain: w.brain,
        computer: null,
        retryDelayMs: 1,
        talkingTo: () => to,
        onTalkTo: (t) => void (to = t),
        toCofounder: (text) => (passed.push(text), "Sent to the co-founder."),
      });
      return { session, brain: w.brain, passed, mode: () => to };
    }

    it("switches by voice; then his words go to the co-founder and never to Jev's brain", async () => {
      const { session, brain, passed, mode } = inMode();
      await session.command("talk to the co-founder", { speak: true });
      expect(mode()).toBe("cofounder");
      const r = await session.command("what are you working on today?", { speak: true });
      expect(passed).toEqual(["what are you working on today?"]);
      expect(brain.sent).toEqual([]);
      expect(r.steps[0]!.lane).toBe("cofounder");
      expect(brain.remembered.map((t) => t.user)).not.toContain("what are you working on today?"); // not Jev's chat
      await session.command("back to Jev", { speak: true });
      expect(mode()).toBe("jev");
    });

    it("the API and MCP still reach Jev, not the co-founder", async () => {
      const { session, passed } = inMode();
      await session.command("talk to the co-founder", { speak: true });
      await session.command("click pricing");
      expect(passed).toEqual([]);
    });

    it('"new chat" there says what it can\'t do instead of sending it on', async () => {
      const { session, brain, passed } = inMode();
      await session.command("talk to the co-founder", { speak: true });
      const r = await session.command("new chat", { speak: true });
      expect(passed).toEqual([]);
      expect(brain.resets).toBe(0);
      expect(r.steps[0]!.result!.text).toMatch(/can't start a fresh conversation/);
    });
  });

  it("a message with a file goes to the brain with the file — never the fast lane, even if it reads like a command", async () => {
    const { session, brain, executor, opened, messages } = withBrain({ computer: true });
    const files = [{ id: "att_1", name: "charter.pdf" }];
    void session.command("open slack", { speak: true, attachments: files });
    await tick();
    expect(opened).toEqual([]);
    expect(executor.executed).toEqual([]);
    expect(brain.sent).toEqual(["open slack"]);
    expect(brain.attached).toEqual([files]);
    expect(messages.find((m) => m.type === "transcript_ack")).toMatchObject({ text: "open slack  📎 charter.pdf" });
    // dropped while that run is still going: it reaches the run by name and id, not lost
    await session.command("and this one", { attachments: [{ id: "att_2", name: "plan.docx" }] });
    expect(brain.steers.at(-1)).toEqual({ runId: "run_1", text: "and this one\n[attached: plan.docx (att_2) — read it with read_doc]" });
    brain.emit("run_1", { kind: "completed", output: "Read it." }, null);
    await tick();
    // a file with no words still means "read this"
    void session.command("", { attachments: files });
    await tick();
    expect(brain.sent.at(-1)).toBe("Read the attached file.");
  });

  it("sends a question to the brain in one piece and streams its events outside the queue", async () => {
    const { session, brain, executor, messages, brainEvents } = withBrain();
    const r = await session.command("find me 20 dentists in austin and put them in a sheet");
    expect(brain.sent).toEqual(["find me 20 dentists in austin and put them in a sheet"]);
    expect(executor.executed).toEqual([]);
    expect(messages.some((m) => m.type === "steps")).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.decision).toMatchObject({ route: "hermes", actionLabel: "Ask Hermes" });
    expect(r.steps[0]!.result).toEqual({ text: "Hermes is on it", level: "ok" });
    // the queue is free: a browser command runs while the brain works
    brain.emit("run_1", { kind: "tool_start", tool: "web_search", preview: "dentists austin" });
    const b = await session.command("click pricing");
    expect(executor.executed.map((a) => a.kind)).toEqual(["click"]);
    expect(b.ok).toBe(true);
    brain.emit("run_1", { kind: "tool_end", tool: "web_search", durationMs: 800, error: false }, { kind: "completed", output: "Done: 20 dentists in the sheet." }, null);
    await tick();
    expect(brainEvents()).toEqual(["tool_start", "tool_end", "completed"]);
    const ev = messages.find((m) => m.type === "brain_event")!;
    expect(ev).toMatchObject({ stepId: r.steps[0]!.stepId, runId: "run_1" });
  });

  it("asks the human when the brain wants approval; a typed yes/no answers it", async () => {
    const { session, brain, messages } = withBrain();
    await session.command("clean up my downloads folder");
    brain.emit("run_1", { kind: "approval", requestId: "req1", summary: "run rm -rf ~/Downloads/*", choices: ["once", "session", "always", "deny"] });
    await tick();
    expect(session.pendingSummary()).toEqual({ kind: "approval", question: "Hermes wants to run rm -rf ~/Downloads/*. Allow it?", choices: ["once", "session", "always", "deny"] });
    expect((await session.status()).pending?.kind).toBe("approval");
    const r = await session.command("yes, always");
    expect(brain.approvals).toEqual([{ runId: "run_1", choice: "always", requestId: "req1" }]);
    expect(r.steps[0]!.result).toEqual({ text: "Allowed: run rm -rf ~/Downloads/*", level: "ok" });
    await tick();
    expect(session.pendingSummary()).toBeNull();
    expect(messages.filter((m) => m.type === "brain_event").map((m) => (m as { event: { kind: string } }).event.kind)).toEqual(["approval", "approved"]);
  });

  it("a typed no denies; a UI choice works too; an unrelated command leaves the request open", async () => {
    const { session, brain, executor } = withBrain();
    await session.command("tidy up");
    brain.emit("run_1", { kind: "approval", requestId: null, summary: "delete old logs", choices: ["once", "deny"] });
    await tick();
    const r = await session.command("scroll down");
    expect(executor.executed.map((a) => a.kind)).toEqual(["scroll"]);
    expect(r.pending?.kind).toBe("approval"); // still waiting
    await session.command("no thanks");
    expect(brain.approvals).toEqual([{ runId: "run_1", choice: "deny", requestId: null }]);
    brain.emit("run_1", { kind: "approval", requestId: "r2", summary: "try again", choices: ["once", "deny"] });
    await tick();
    const ui = await session.approve("once");
    expect(ui.steps[0]!.result?.text).toBe("Allowed: try again");
    expect(brain.approvals.at(-1)).toEqual({ runId: "run_1", choice: "once", requestId: "r2" });
  });

  it("stop halts the brain run as well as local work; cancel() too", async () => {
    const { session, brain } = withBrain();
    await session.command("research quantum computing for me");
    const r = await session.command("stop");
    expect(r.steps[0]!.result).toEqual({ text: "Stopped", level: "ok" });
    expect(brain.stops).toEqual(["run_1"]);
    await tick();
    await session.command("write me a poem");
    session.cancel();
    expect(brain.stops).toEqual(["run_1", "run_2"]);
  });

  it("interrupt() cancels the current brain run only", async () => {
    const { session, brain } = withBrain();
    await session.command("research quantum computing for me");
    session.interrupt();
    expect(brain.stops).toEqual(["run_1"]);
  });

  it("a second brain-bound utterance while a run is active steers it", async () => {
    const { session, brain } = withBrain();
    await session.command("find me a hotel in paris");
    const r = await session.command("make it one near the louvre");
    expect(brain.sent).toEqual(["find me a hotel in paris"]);
    expect(brain.steers).toEqual([{ runId: "run_1", text: "make it one near the louvre" }]);
    expect(r.steps[0]!.result).toEqual({ text: "Told Hermes: make it one near the louvre", level: "ok" });
    brain.emit("run_1", { kind: "completed", output: "Booked." }, null);
    await tick();
    await session.command("find me a train too");
    expect(brain.sent).toHaveLength(2);
  });

  it("ask() waits for the brain's answer; a failed run is reported", async () => {
    const { session, brain } = withBrain();
    const p = session.ask("what time is it in tokyo");
    await tick();
    brain.emit("run_1", { kind: "completed", output: "It is 9 am in Tokyo." }, null);
    expect(await p).toMatchObject({ ok: true, output: "It is 9 am in Tokyo." });
    const q = session.ask("and in lima");
    await tick();
    brain.emit("run_2", { kind: "failed", error: "model timeout" }, null);
    expect(await q).toMatchObject({ ok: false, output: "model timeout" });
    const local = await session.ask("scroll down");
    expect(local.output).toBe("did scroll");
  });

  it("steps of an utterance routed to the browser stay in the browser, even when one reads like a question", async () => {
    const { brain, executor } = withBrain();
    // Jev may call "search for cats" on its own a question for the brain; inside a page sequence it is a search
    const decider = new HeuristicDecider();
    const decide = decider.decide.bind(decider);
    decider.decide = async (...args) => {
      const d = await decide(...args);
      if (d.command === "search for cats") Object.assign(d, { route: "hermes", routeConfidence: 0.98 });
      return d;
    };
    const session = new Session("fake3", { executor, decider, brain });
    const r = await session.command("open wikipedia and search for cats");
    expect(brain.sent).toEqual([]);
    expect(executor.executed.map((a) => a.kind)).toEqual(["navigate", "search"]);
    expect(r.steps.map((s) => s.decision?.route)).toEqual(["browser_now", "browser_now"]);
  });

  it("a question goes to the brain, not to a Google search — but an explicit search still searches", async () => {
    const { session, brain, executor } = withBrain();
    const searchy = new HeuristicDecider();
    const decide = searchy.decide.bind(searchy);
    // the live misroute: Jev read a question as a plain web search
    searchy.decide = async (...args) => {
      const d = await decide(...args);
      Object.assign(d, { route: "browser_now", intent: "search", action: { kind: "search", query: d.command, url: `https://www.google.com/search?q=${encodeURIComponent(d.command)}` } });
      return d;
    };
    const s = new Session("fake3", { executor, decider: searchy, brain });
    await s.command("what's the top story on hacker news right now");
    expect(brain.sent).toEqual(["what's the top story on hacker news right now"]);
    expect(executor.executed).toEqual([]);
    brain.emit("run_1", { kind: "completed", output: "Ollaya." }, null);
    await tick();
    await s.command("search for cats");
    expect(executor.executed.map((a) => a.kind)).toEqual(["search"]);
    expect(brain.sent).toHaveLength(1);
  });

  it("a question that names a site is answered, not opened in his tab (live 2026-09-29); 'can you open X?' still opens", async () => {
    const { executor, brain } = withBrain();
    const navvy = new HeuristicDecider();
    const decide = navvy.decide.bind(navvy);
    navvy.decide = async (...args) => {
      const d = await decide(...args);
      Object.assign(d, { route: "browser_now", intent: "navigate", action: { kind: "navigate", url: "https://news.ycombinator.com" } });
      return d;
    };
    const s = new Session("fake4", { executor, decider: navvy, brain });
    await s.command("What are the titles of the top two stories on news.ycombinator.com right now? Check it in Chrome.");
    expect(executor.executed).toEqual([]);
    expect(brain.sent).toHaveLength(1);
    brain.emit("run_1", { kind: "completed", output: "Two titles." }, null);
    await tick();
    await s.command("can you open news.ycombinator.com");
    expect(executor.executed.map((a) => a.kind)).toEqual(["navigate"]);
    expect(wantsAnswer("could you please pull up gmail?")).toBe(false);
    expect(wantsAnswer("what's on news.ycombinator.com")).toBe(true);
  });

  it("recognises questions, and leaves explicit searches alone", () => {
    for (const q of ["what's the top story on hacker news", "who won last night?", "how many unread emails do I have", "hey jev, is it raining in austin", "tell me about ada lovelace"]) expect(isQuestion(q), q).toBe(true);
    for (const c of ["search for cats", "google the weather in austin", "look up flights to denver", "open wikipedia", "cats"]) expect(isQuestion(c), c).toBe(false);
  });

  it("greetings go to the brain, but a half-heard fragment NEVER does", async () => {
    const { session, brain, executor } = withBrain();
    const r = await session.command("yo can you hear me");
    expect(brain.sent).toEqual(["yo can you hear me"]);
    expect(r.steps[0]!.decision).toMatchObject({ route: "hermes" });
    brain.emit("run_1", { kind: "completed", output: "Loud and clear." }, null);
    await tick();
    // v11 rule 1: an aside near the microphone once started a run that acted on the Mac. Jev's
    // "unclear" is now answered exactly as it would be with no brain configured.
    const unclear = new HeuristicDecider();
    const decide = unclear.decide.bind(unclear);
    unclear.decide = async (...args) => {
      const d = await decide(...args);
      if (d.command === "the the") Object.assign(d, { route: "unclear", intent: "unclear", action: { kind: "none", reason: "That didn't sound like it was for me" } });
      return d;
    };
    const quiet = new Session("fake2", { executor, decider: unclear, brain });
    const decided = await quiet.command("the the");
    expect(decided.steps[0]!.decision?.route).toBe("unclear");
    expect(decided.steps[0]!.result).toEqual({ text: "That didn't sound like it was for me", level: "warn" });
    expect(brain.sent).toEqual(["yo can you hear me"]);
    expect(brain.steers).toEqual([]);
    expect(executor.executed).toEqual([]);
  });

  it("'new conversation' resets the brain", async () => {
    const { session, brain, messages } = withBrain();
    await session.command("what's on my calendar today");
    const r = await session.command("start a new conversation");
    expect(brain.stops).toEqual(["run_1"]);
    expect(brain.resets).toBe(1);
    expect(r.steps[0]!.result).toEqual({ text: "New chat — the earlier conversation is closed", level: "ok" });
    expect(messages).toContainEqual({ type: "new_chat", stepId: r.steps[0]!.stepId });
    expect(brain.sent).toEqual(["what's on my calendar today"]);
  });

  it("a model error before any tool ran is retried on the same conversation, then a fresh one", async () => {
    const { session, brain, brainEvents } = withBrain();
    const asked = session.ask("what's the weather");
    await tick();
    brain.emit("run_1", { kind: "failed", error: "ollama-cloud kimi-k3 HTTP 400 Bad Request", providerFailure: true }, null);
    await waitFor(() => brain.sent.length === 2);
    expect(brain.freshFlags).toEqual([false, false]);
    brain.emit("run_2", { kind: "failed", error: "HTTP 400 Bad Request", providerFailure: true }, null);
    await waitFor(() => brain.sent.length === 3);
    expect(brain.freshFlags).toEqual([false, false, true]);
    expect(brain.resets).toBe(0); // `fresh` leaves the chat out of one request; it never ends the chat
    brain.emit("run_3", { kind: "completed", output: "Sunny, 72." }, null);
    const r = await asked;
    expect(r).toMatchObject({ ok: true, output: "Sunny, 72." });
    expect(brainEvents()).toEqual(["failed", "retrying", "failed", "retrying", "completed"]);
  });

  it("gives up after the third model error and says so", async () => {
    const { session, brain } = withBrain();
    const asked = session.ask("what's the weather");
    await tick();
    for (const id of ["run_1", "run_2", "run_3"]) {
      brain.emit(id, { kind: "failed", error: "HTTP 400 Bad Request", providerFailure: true }, null);
      if (id !== "run_3") await waitFor(() => brain.sent.length === Number(id.slice(-1)) + 1);
    }
    const r = await asked;
    expect(r.ok).toBe(false);
    expect(r.output).toBe("Hermes's model keeps erroring, even without the earlier chat in view. Give it a moment and say it again.");
    expect(brain.resets).toBe(0); // only the user ends a chat
  });

  it("a model error after a tool ran is not re-sent, and repeated errors never end the chat", async () => {
    const { session, brain } = withBrain();
    const first = session.ask("leave a note for xander in slack");
    await tick();
    brain.emit("run_1", { kind: "tool_start", tool: "jev_status", preview: "" }, { kind: "tool_end", tool: "jev_status", durationMs: 5, error: false });
    brain.emit("run_1", { kind: "failed", error: "ollama-cloud kimi-k3 HTTP 400 Bad Request", providerFailure: true }, null);
    const r1 = await first;
    expect(brain.sent).toHaveLength(1);
    expect(r1.output).toBe("Hermes hit an error from its model after jev status. Say it again and I'll retry.");
    expect(brain.resets).toBe(0);

    const second = session.ask("check my email");
    await tick();
    brain.emit("run_2", { kind: "tool_start", tool: "jev_browse", preview: "" }, { kind: "failed", error: "HTTP 400 Bad Request", providerFailure: true }, null);
    const r2 = await second;
    expect(r2.output).toBe("Hermes hit an error from its model after jev browse. Say it again and I'll retry.");
    expect(brain.resets).toBe(0);

    // an ordinary failure is not a model error: no retry, no rotation
    const third = session.ask("and now");
    await tick();
    brain.emit("run_3", { kind: "failed", error: "model timeout" }, null);
    expect((await third).output).toBe("model timeout");
    expect(brain.resets).toBe(0);
  });

  it("stop during a retry pause abandons the retry", async () => {
    const { session, brain } = withBrain();
    const asked = session.ask("what's the weather");
    await tick();
    brain.emit("run_1", { kind: "failed", error: "HTTP 400 Bad Request", providerFailure: true }, null);
    await session.command("stop");
    await new Promise((r) => setTimeout(r, 10));
    expect(brain.sent).toHaveLength(1);
    expect((await asked).ok).toBe(false);
  });

  it("an unreachable brain is an error, not a hang", async () => {
    const { session, brain } = withBrain();
    brain.failSend = "Hermes API unreachable at http://127.0.0.1:8642";
    const r = await session.command("what did I ask you yesterday");
    expect(r.ok).toBe(false);
    expect(r.steps[0]!.result).toMatchObject({ level: "error", text: /unreachable/ });
  });

  it("opens apps through the computer lane, or hands them to the brain without one", async () => {
    const withMac = withBrain({ computer: true });
    const r = await withMac.session.command("open slack");
    expect(withMac.opened).toEqual(["slack"]);
    expect(r.steps[0]!.result).toEqual({ text: "Opened slack", level: "ok" });
    expect(r.steps[0]!.decision).toMatchObject({ route: "computer", action: { kind: "open_app", app: "slack" } });
    expect(withMac.brain.sent).toEqual([]);
    const noMac = withBrain();
    await noMac.session.command("open slack");
    expect(noMac.brain.sent).toEqual(["open slack"]);
  });

  it("a chained app-open command runs both steps locally even with a brain configured", async () => {
    // regression: deciding the whole joined string before splitting used to fail to extract
    // an app name from the trailing clause, downgrade to the brain, and — since a brain is
    // configured — send the ENTIRE utterance as one message, never opening Slack at all.
    const { session, opened, brain, messages } = withBrain({ computer: true });
    const r = await session.command("open slack and click general");
    expect(opened).toEqual(["slack"]);
    expect(brain.sent).toEqual([]); // never lumped into one brain message
    expect(messages.some((m) => m.type === "steps")).toBe(true);
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0]!.decision).toMatchObject({ route: "computer", action: { kind: "open_app", app: "slack" } });
    expect(r.steps[1]!.decision).not.toBeNull(); // step 2 gets its own fresh decision, not swallowed
  });

  it("opens a file by name: one match opens, a few become a question, none go to the brain", async () => {
    const one = withBrain({ computer: true, files: { resume: ["/Users/j/Documents/Resume 2026.pdf"] } });
    const r = await one.session.command("open my resume");
    expect(r.steps[0]!.decision).toMatchObject({ route: "computer", action: { kind: "open_path", query: "resume" } });
    expect(one.opened).toEqual(["/Users/j/Documents/Resume 2026.pdf"]);
    expect(r.steps[0]!.result).toEqual({ text: "Opened Resume 2026.pdf", level: "ok" });
    expect(one.brain.sent).toEqual([]);

    const few = withBrain({ computer: true, files: { resume: ["/Users/j/Documents/Resume 2026.pdf", "/Users/j/Downloads/resume-old.docx"] } });
    const q = await few.session.command("open my resume");
    expect(q.ok).toBe(false); // a question is open: the command is not done
    expect(q.pending?.kind).toBe("clarify");
    expect(few.opened).toEqual([]);
    expect(few.session.pendingSummary()).toEqual({
      kind: "clarify",
      question: "I found 2 files called resume. Which one:",
      options: [
        { elementId: "file:0", label: "Resume 2026.pdf (Documents)", probability: 0 },
        { elementId: "file:1", label: "resume-old.docx (Downloads)", probability: 0 },
      ],
    });
    const pick = await few.session.command("the second one");
    expect(few.opened).toEqual(["/Users/j/Downloads/resume-old.docx"]);
    expect(pick.steps[0]!.result).toEqual({ text: "Opened resume-old.docx", level: "ok" });
    expect(few.session.pendingSummary()).toBeNull();
    expect(few.executor.executed).toEqual([]); // a file pick is never a page click

    const none = withBrain({ computer: true });
    await none.session.command("open my resume");
    expect(none.opened).toEqual([]);
    expect(none.brain.sent).toEqual(["open my resume"]); // Spotlight found nothing: the brain can look harder
  });

  it("local commands (the brain's own jev_browse) never reach the brain", async () => {
    const { session, brain, executor } = withBrain();
    const r = await session.command("find me 20 dentists in austin and put them in a sheet", { local: true });
    expect(brain.sent).toEqual([]);
    expect(executor.executed.map((a) => a.kind)).toEqual(["search"]); // split into browser steps instead
    expect(r.steps[0]!.command).toBe("find me 20 dentists in austin");
    const w = await session.command("what did I ask you yesterday", { local: true });
    expect(w.steps[0]!.result).toMatchObject({ level: "warn", text: /needs the assistant/ });
    expect(brain.sent).toEqual([]);
    await session.command("what did I ask you yesterday");
    expect(brain.sent).toEqual(["what did I ask you yesterday"]);
  });

  it("without a brain, hermes-routed commands fall back to the browser action or a warning", async () => {
    const { session, executor } = make();
    const r = await session.command("find me 20 dentists in austin");
    expect(executor.executed.map((a) => a.kind)).toEqual(["search"]);
    expect(r.steps[0]!.decision).toMatchObject({ route: "hermes" });
    const w = await session.command("what did I ask you yesterday");
    expect(w.steps[0]!.result?.level).toBe("warn");
    const mac = await session.command("open slack");
    expect(mac.steps[0]!.result).toMatchObject({ level: "warn", text: /can't open apps/ });
  });
});

describe("Session: brain approval beside a browser question", () => {
  const risky = [el("e0", { tag: "button", text: "Delete account" })];
  function both() {
    const executor = new FakeExecutor(risky);
    const brain = new FakeBrain();
    const session = new Session("fake", { executor, decider: new HeuristicDecider(), brain });
    return { executor, brain, session };
  }

  it("neither question clobbers the other; a yes answers the browser first, then the approval outcome is reported", async () => {
    const { session, brain, executor } = both();
    await session.command("summarize my week");
    const c = await session.command("click delete account");
    expect(c.pending?.kind).toBe("confirm");
    brain.emit("run_1", { kind: "approval", requestId: "r1", summary: "read your calendar", choices: ["once", "deny"] });
    await tick();
    expect(session.pending?.kind).toBe("confirm");
    expect(session.approval?.runId).toBe("run_1");
    const r = await session.command("yes");
    expect(executor.executed.map((a) => a.kind)).toEqual(["click"]);
    expect(brain.approvals).toEqual([]);
    expect(r.ok).toBe(true); // the parked approval does not fail the command…
    expect(r.pending).toEqual({ kind: "approval", question: "Hermes wants to read your calendar. Allow it?", choices: ["once", "deny"] });
    const a = await session.command("yes");
    expect(brain.approvals).toEqual([{ runId: "run_1", choice: "once", requestId: "r1" }]);
    expect(a.steps[0]!.result?.text).toBe("Allowed: read your calendar");
  });

  it("a browser question arriving while an approval is parked keeps both; the UI can answer each", async () => {
    const { session, brain, executor } = both();
    await session.command("summarize my week");
    brain.emit("run_1", { kind: "approval", requestId: "r1", summary: "read your calendar", choices: ["once", "deny"] });
    await tick();
    await session.command("click delete account");
    expect(session.pending?.kind).toBe("confirm");
    expect(session.approval?.runId).toBe("run_1");
    expect((await session.status()).pending?.kind).toBe("confirm");
    await session.approve("deny");
    expect(brain.approvals).toEqual([{ runId: "run_1", choice: "deny", requestId: "r1" }]);
    expect(session.pending?.kind).toBe("confirm"); // untouched
    await session.reply(true);
    expect(executor.executed.map((a) => a.kind)).toEqual(["click"]);
  });

  it("stop during a pending approval stops the run instead of denying", async () => {
    const { session, brain } = both();
    await session.command("summarize my week");
    brain.emit("run_1", { kind: "approval", requestId: "r1", summary: "read your calendar", choices: ["once", "deny"] });
    await tick();
    const r = await session.command("stop");
    expect(brain.approvals).toEqual([]);
    expect(brain.stops).toEqual(["run_1"]);
    expect(session.approval).toBeNull();
    expect(r.steps[0]!.result).toEqual({ text: "Stopped", level: "ok" });
  });

  it("a stop word inside a browser confirm cancels it and stops the brain too", async () => {
    const { session, brain } = both();
    await session.command("summarize my week");
    await session.command("click delete account");
    await session.command("never mind");
    expect(brain.stops).toEqual(["run_1"]);
    expect(session.pending).toBeNull();
  });
});

describe("Session: degraded modes", () => {
  it("a brain stream that throws still resolves ask()", async () => {
    const executor = new FakeExecutor();
    const brain = new FakeBrain();
    const session = new Session("fake", { executor, decider: new HeuristicDecider(), brain });
    const asked = session.ask("what's the weather");
    await tick();
    brain.throwOn("run_1", new Error("socket hang up"));
    const r = await asked;
    expect(r).toMatchObject({ ok: false, output: "socket hang up" });
  });
});

describe("Session: the pause switch", () => {
  it("'go to sleep' stops everything, asks the host to pause, and says so", async () => {
    const executor = new FakeExecutor();
    const brain = new FakeBrain();
    let paused = false;
    const session = new Session("fake", { executor, decider: new HeuristicDecider(), brain, onSleep: () => (paused = true) });
    await session.command("what's on my calendar");
    const r = await session.command("go to sleep");
    expect(paused).toBe(true);
    expect(r.steps[0]!.result?.text).toMatch(/^Okay, going quiet/);
    expect(brain.sent).toEqual(["what's on my calendar"]); // the sleep command never reaches the brain
    // "that's all for now" counts too; a question does not
    expect(isSleepCommand("that's all for now.")).toBe(true);
    expect(isSleepCommand("shut up")).toBe(true);
    expect(isSleepCommand("turn off the lights")).toBe(false);
    // Bare "pause" was in this list and is deliberately no longer: handleCommand checks
    // isSleepCommand before anything else, so once media controls existed, saying "pause" put JEV
    // to sleep instead of pausing the music. See test/controls.test.ts for the other half.
    expect(isSleepCommand("pause")).toBe(false);
  });
});

/** A Session with a control-capable Computer, at module scope so the control suite can use it. */
function mkControls(opts: { noControls?: boolean; fail?: Error } = {}) {
  const executor = new FakeExecutor([el("e0", { text: "Pricing", hrefShort: "/pricing" })]);
  const brain = new FakeBrain();
  const opened: string[] = [];
  const controls: Control[] = [];
  /** Statuses and control calls in ONE list, so SPEAK_FIRST's ordering is assertable rather than
   *  merely "a status mentioning mute exists somewhere". */
  const trace: string[] = [];
  const computer = {
    openApp: async (app: string) => { opened.push(app); return `Opened ${app}`; },
    findFiles: async () => [],
    openPath: async (p: string) => { opened.push(p); return `Opened ${p}`; },
    ...(opts.noControls
      ? {}
      : {
          control: async (c: Control) => {
            trace.push(`did:${lineKey(c)}`);
            controls.push(c);
            opened.push(`control:${lineKey(c)}`);
            if (opts.fail) throw opts.fail;
            return describeControl(c);
          },
        }),
  };
  const messages: ServerMessage[] = [];
  const session = new Session("fake", { executor, decider: new HeuristicDecider(), brain, computer, retryDelayMs: 1 });
  session.subscribe((m) => {
    messages.push(m);
    if (m.type === "status" && m.level !== "busy") trace.push(`said:${m.text}`);
  });
  return { executor, brain, opened, controls, session, messages, trace };
}

describe("Session: the direct lane (Mac controls)", () => {

  it("runs a control instead of handing it to a brain that has no hands for it", async () => {
    const { session, controls, brain } = mkControls();
    const r = await session.command("turn the volume down");
    expect(controls).toEqual([{ target: "volume", action: "down" }]);
    expect(brain.sent).toEqual([]);
    expect(r.steps[0]?.result?.level).toBe("ok");
  });

  it("THE HEADLINE CASE: one utterance, a control and an app launch, both run", async () => {
    // "turn Spotify down and open Slack" starts with a control, so the multi-clause pre-check in
    // handleCommand used to run on the whole string, decide it as one `computer` step, and drop
    // "open Slack" without a word — the v4 P0 bug reached through a new door.
    const { session, opened, controls } = mkControls();
    const r = await session.command("turn spotify down and open slack");
    expect(controls).toEqual([{ target: "volume", action: "down", scope: "spotify" }]);
    expect(opened).toEqual(["control:app_volume_down", "slack"]);
    expect(r.steps).toHaveLength(2);
  });

  it("...and in the other order, which needs splitSteps to know the vocabulary", async () => {
    const { session, opened, controls } = mkControls();
    await session.command("open slack and mute");
    expect(opened).toEqual(["slack", "control:volume_mute"]);
    expect(controls).toEqual([{ target: "volume", action: "mute" }]);
  });

  it("speaks BEFORE muting, and AFTER everything else", async () => {
    // hey-jev's SPEAK_FIRST: mute the speaker first and the reply is inaudible; lock the screen
    // first and it is spoken to a machine nobody is looking at. Asserted as an ORDER, because once
    // M5 makes it audible the order is the entire feature.
    const muted = mkControls();
    await muted.session.command("mute");
    expect(muted.trace.map((t) => t.split(":")[0])).toEqual(["said", "did"]);

    const skipped = mkControls();
    await skipped.session.command("next track");
    expect(skipped.trace.map((t) => t.split(":")[0])).toEqual(["did", "said"]);

    const locked = mkControls();
    await locked.session.command("lock my computer");
    expect(locked.trace.map((t) => t.split(":")[0])).toEqual(["said", "did"]);
  });

  it("never shows Fish's emotion tags to a human", async () => {
    // `[cheerful]` is delivery for the voice model and literal text to everyone else — the panel,
    // /api/ask and Hermes over MCP all read this string.
    const { session, messages, trace } = mkControls();
    await session.command("turn spotify down");
    for (const m of messages) if (m.type === "status") expect(m.text).not.toMatch(/\[[a-z]/i);
    for (const t of trace) expect(t).not.toMatch(/\[[a-z]/i);
  });

  it("reports 'nothing to act on' as a warning, not as success or a crash", async () => {
    const err = Object.assign(new Error("Spotify isn't open"), { name: "NotRunning" });
    const { session } = mkControls({ fail: err });
    const r = await session.command("turn spotify down");
    expect(r.steps[0]?.result).toEqual({ text: "Spotify isn't open", level: "warn" });
  });

  it("keeps a browser-first compound on the browser lane and still runs the control", async () => {
    // pinBrowser keeps later steps of a browser-routed utterance on the fast lane; the control
    // check must still be reached for the second clause.
    const { session, controls, executor } = mkControls();
    await session.command("click the pricing link and mute");
    expect(executor.executed.map((a) => a.kind)).toEqual(["click"]);
    expect(controls).toEqual([{ target: "volume", action: "mute" }]);
  });

  it("says so plainly when the machine cannot do it, rather than failing silently", async () => {
    const { session } = mkControls({ noControls: true });
    const r = await session.command("lock my computer");
    expect(r.steps[0]?.result?.level).toBe("warn");
    expect(r.steps[0]?.result?.text).toMatch(/can't lock the screen/i);
  });

  it("leaves the browser lane exactly where it was", async () => {
    const { session, controls, executor } = mkControls();
    await session.command("click the pricing link");
    expect(controls).toEqual([]);
    expect(executor.executed.map((a) => a.kind)).toEqual(["click"]);
  });
});

describe("Session: everything speaks", () => {
  /** A session with a recording voice, so what Jev SAYS is asserted rather than what she displays. */
  function mkVoice(opts: { brain?: boolean; ackAfterMs?: number } = {}) {
    const spoken: string[] = [];
    const speaker = { speak: async (t: string) => void spoken.push(t), stop: () => {}, maxChars: 600 };
    const executor = new FakeExecutor([el("e0", { text: "Pricing", hrefShort: "/pricing" }), el("e1", { text: "Delete account" })]);
    const brain = opts.brain ? new FakeBrain() : null;
    const controls: Control[] = [];
    const session = new Session("fake", {
      executor,
      decider: new HeuristicDecider(),
      speaker,
      ...(brain ? { brain } : {}),
      ...(opts.ackAfterMs != null ? { ackAfterMs: opts.ackAfterMs } : {}),
      computer: {
        openApp: async (app: string) => `Opened ${app}`,
        findFiles: async () => [],
        openPath: async (p: string) => `Opened ${p}`,
        control: async (c: Control) => { controls.push(c); return describeControl(c); },
      },
    });
    const messages: ServerMessage[] = [];
    session.subscribe((m) => messages.push(m));
    const settle = () => new Promise((r) => setTimeout(r, 5));
    return { session, spoken, executor, brain: brain!, controls, messages, settle };
  }

  describe('"On it." while a spoken run works', () => {
    const onIt = (spoken: string[]) => spoken.filter((t) => /on it|working on it/i.test(t));

    it("is replaced by the lead's own plan line, and tool calls alone don't trigger it", async () => {
      const { session, brain, spoken, settle } = mkVoice({ brain: true, ackAfterMs: 30 });
      const done = session.command("log into salesforce and make the app", { speak: true });
      await settle();
      brain.emit("run_1", { kind: "say", text: "Logging into Salesforce to make the app — I'll tell you when the keys are in place." }, { kind: "tool_start", tool: "chrome", preview: "" });
      await new Promise((r) => setTimeout(r, 60)); // well past the fallback timer
      expect(spoken).toContain("Logging into Salesforce to make the app — I'll tell you when the keys are in place.");
      expect(onIt(spoken)).toEqual([]);
      brain.emit("run_1", { kind: "completed", output: "Done — the keys are in your .env." }, null);
      await done;
      await settle();
      expect(onIt(spoken)).toEqual([]);
    });

    it("is said when nothing has come back in time", async () => {
      const { session, spoken } = mkVoice({ brain: true, ackAfterMs: 5 });
      void session.command("what's the weather", { speak: true });
      await new Promise((r) => setTimeout(r, 30));
      expect(onIt(spoken)).toHaveLength(1);
    });

    it("is not said when the answer arrives first, or when nobody is listening", async () => {
      const quick = mkVoice({ brain: true, ackAfterMs: 20 });
      const done = quick.session.command("what's the weather", { speak: true });
      await quick.settle();
      quick.brain.emit("run_1", { kind: "completed", output: "Sunny." }, null);
      await done;
      await new Promise((r) => setTimeout(r, 40));
      expect(onIt(quick.spoken)).toEqual([]);

      const api = mkVoice({ brain: true, ackAfterMs: 5 });
      void api.session.command("what's the weather");
      await api.settle();
      api.brain.emit("run_1", { kind: "tool_start", tool: "shell", preview: "" });
      await new Promise((r) => setTimeout(r, 30));
      expect(onIt(api.spoken)).toEqual([]);
    });
  });

  it("reads the outcome of an ordinary action out loud", async () => {
    const { session, spoken } = mkVoice();
    await session.command("click pricing", { speak: true });
    expect(spoken.join(" ")).toMatch(/did click/i); // the executor's own outcome, read back
  });

  it("says nothing at all unless a human asked by voice or at the panel", async () => {
    // The negative test that protects a 09:00 kitchen: /api/* and MCP pass no `speak`, so the
    // Monday review and Hermes-from-Telegram both stay silent.
    const { session, spoken } = mkVoice();
    await session.command("click pricing");
    await session.command("click pricing", { local: true });
    expect(spoken).toEqual([]);
  });

  it("reads the question when it has to ask, rather than stopping silently", async () => {
    const { session, spoken } = mkVoice();
    const r = await session.command("click delete account", { speak: true });
    // the decider parks this behind a question; whichever kind, it must be audible
    expect(r.pending?.kind === "confirm" || r.pending?.kind === "clarify").toBe(true);
    expect(spoken.join(" ").length).toBeGreaterThan(0);
    const said = spoken.join(" ").toLowerCase();
    expect(said).toMatch(/delete|which|sure|shall/);
  });

  it("does not say a control's outcome twice", async () => {
    // A control speaks its own scripted line; the end-of-turn summary must not then repeat it.
    const { session, spoken } = mkVoice();
    await session.command("mute", { speak: true });
    expect(spoken).toHaveLength(1);
  });

  it("speaks the brain's answer, which arrives long after the turn resolved", async () => {
    const { session, spoken, brain, settle } = mkVoice({ brain: true });
    await session.command("what's on my calendar today", { speak: true });
    // Nothing yet: handing the job over is not an answer, and saying so would talk over her own work.
    expect(spoken).toEqual([]);
    brain.emit("run_1", { kind: "completed", output: "Two things: a dentist at ten, and lunch with Xander." });
    await settle();
    expect(spoken.join(" ")).toMatch(/dentist at ten/);
  });

  it("asks the brain's write question out loud, and a spoken yes answers it", async () => {
    const { session, spoken, brain, settle } = mkVoice({ brain: true });
    await session.command("send xander hi in slack", { speak: true });
    brain.emit("run_1", { kind: "approval", requestId: "ask_1", summary: 'click "Send" in Chrome', choices: ["once", "deny"] });
    await settle();
    expect(spoken.join(" ")).toContain('wants to click "Send" in Chrome. Allow it?');
    await session.command("yes", { speak: true });
    expect(brain.approvals).toEqual([{ runId: "run_1", choice: "once", requestId: "ask_1" }]);
  });

  it("says so out loud when the brain fails, instead of going quiet", async () => {
    // A spoken turn that fails silently is indistinguishable from one still working.
    const { session, spoken, brain, settle } = mkVoice({ brain: true });
    await session.command("what's on my calendar today", { speak: true });
    brain.emit("run_1", { kind: "failed", error: "the calendar tool is not configured" });
    await settle();
    expect(spoken.join(" ")).toMatch(/couldn't finish|not configured/i);
  });

  it("hushes the voice without cancelling the brain run behind it", async () => {
    // Escape, ⌥Space and pressing the microphone all hush. None of them may cancel the run: the
    // reason to press the microphone mid-answer is usually to ADD to the request, and v3 built
    // steering on that. Only the Stop button interrupts.
    let stopped = 0;
    const spoken: string[] = [];
    const brain = new FakeBrain();
    const session = new Session("fake", {
      executor: new FakeExecutor([el("e0", { text: "Pricing", hrefShort: "/pricing" })]),
      decider: new HeuristicDecider(),
      brain,
      speaker: { speak: async (t: string) => void spoken.push(t), stop: () => void stopped++, maxChars: 600 },
    });
    await session.command("what's on my calendar today", { speak: true });
    session.hush();
    expect(stopped).toBe(1);
    expect(brain.stops).toEqual([]); // the run is untouched...
    // ...so the next thing said is a steer on the same conversation, not a new one
    await session.command("and also check tomorrow", { speak: true });
    expect(brain.steers.map((s) => s.text)).toEqual(["and also check tomorrow"]);
    expect(brain.sent).toHaveLength(1);

    // The Stop button is the one that cancels.
    session.interrupt();
    expect(brain.stops).toEqual(["run_1"]);
    expect(stopped).toBe(2);
  });

  it("reads out what happened after a question is answered by clicking", async () => {
    // The question is spoken; without this its answer lands in silence, which from across the room is
    // indistinguishable from Jev having ignored the click.
    const { session, spoken } = mkVoice();
    const r = await session.command("click delete account", { speak: true });
    const pending = r.pending;
    expect(pending).not.toBeNull();
    spoken.length = 0;
    if (pending?.kind === "clarify") await session.pick(pending.options[0]!.elementId, { speak: true });
    else await session.reply(true, { speak: true });
    expect(spoken.length).toBeGreaterThan(0);
  });

  it("keeps a brain answer silent when nobody was listening", async () => {
    // No `speak`, which is what /api/* and MCP pass — not `local`, which refuses the brain lane outright.
    const { session, spoken, brain, settle } = mkVoice({ brain: true });
    await session.command("what's on my calendar today");
    brain.emit("run_1", { kind: "completed", output: "Two things: a dentist at ten." });
    await settle();
    expect(spoken).toEqual([]);
  });
});

describe("Session: timers", () => {
  /** A session whose clock and scheduler the test drives, so nothing waits for real time. */
  function mkTimers() {
    let now = 1_000_000;
    const fires: Array<{ at: number; fire: () => void }> = [];
    const spoken: string[] = [];
    const prepared: string[] = [];
    const speaker = {
      speak: async (t: string) => void spoken.push(t),
      prepare: async (t: string) => void prepared.push(t),
      stop: () => {},
      maxChars: 600,
    };
    const messages: ServerMessage[] = [];
    const session = new Session("fake", {
      executor: new FakeExecutor([]),
      decider: new HeuristicDecider(),
      speaker,
      timers: new TimerStore(() => now),
      scheduleTimer: (ms, fire) => fires.push({ at: now + ms, fire }),
    });
    session.subscribe((m) => messages.push(m));
    const statuses = () => messages.filter((m): m is Extract<ServerMessage, { type: "status" }> => m.type === "status").map((m) => m.text);
    return {
      session,
      messages,
      statuses,
      spoken,
      prepared,
      tick: (ms: number) => {
        now += ms;
        for (const f of fires.splice(0)) if (f.at <= now) f.fire();
      },
    };
  }

  it("sets a timer, says how long, and speaks when it fires", async () => {
    const { session, statuses, spoken, tick } = mkTimers();
    await session.command("set a timer for 10 minutes", { speak: true });
    expect(statuses().at(-1)).toMatch(/10 minutes/);
    expect(spoken).toHaveLength(1);
    tick(600_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(statuses().at(-1)).toMatch(/[Tt]ime's up/);
    // The alert has to be SAID, not merely written to the panel. This assertion is the whole point
    // of the timer: it fires from outside the command queue, minutes after the turn that set it
    // ended, so anything that reads "is this turn speaking?" at fire time finds `false` and the
    // alarm is silent — which looks identical to a working timer in the log.
    expect(spoken.at(-1)).toMatch(/[Tt]ime's up/);
  });

  it("renders the alert WHILE the timer runs, so firing is instant", async () => {
    // hey-jev's prepare_reminder: synthesising at the moment the alarm is due means the user waits
    // through it. The whole point of a timer is that the deadline is known in advance.
    const { session, prepared } = mkTimers();
    await session.command("remind me in 20 minutes to call Bob", { speak: true });
    expect(prepared.some((t) => /call bob/i.test(t))).toBe(true);
  });

  it("reads the label back, in the user's own words", async () => {
    const { session, statuses } = mkTimers();
    await session.command("remind me in 5 minutes to email Sarah", { speak: true });
    // Case is lost on the way in and that is a known, accepted limitation: splitSteps runs
    // normalizeSpeech before anything sees the utterance, so by the time the timer lane reads the
    // label it is already lower-cased. Fixing that means changing normalizeSpeech, which ~300 tests
    // and the whole matching layer depend on — for a cosmetic gain, since Fish reads "email sarah"
    // and "email Sarah" identically. parseReminder itself preserves case for callers that hand it
    // unnormalized text (/api/task, MCP), which is covered in test/timers.test.ts.
    expect(statuses().at(-1)?.toLowerCase()).toContain("email sarah");
  });

  it("answers how long is left, and says so when there is nothing running", async () => {
    const { session, statuses, tick } = mkTimers();
    await session.command("how long is left");
    expect(statuses().at(-1)).toMatch(/no timer running/i);

    await session.command("set a timer for 10 minutes");
    tick(60_000);
    await session.command("how long is left");
    expect(statuses().at(-1)).toMatch(/9 minutes/);
  });

  it("cancels, and a cancelled timer never fires", async () => {
    const { session, statuses, spoken, tick } = mkTimers();
    await session.command("set a timer for 10 minutes", { speak: true });
    await session.command("cancel the timer");
    // the reply is picked at random from several wordings, so assert the outcome, not one wording
    expect(LINES.timer_cancel!.map(withoutTags)).toContain(statuses().at(-1));
    const before = spoken.length;
    tick(600_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(spoken).toHaveLength(before);
  });

  it("stays quiet for a caller that is not a human at the panel", async () => {
    // The 09:00 scheduled review and Hermes-from-Telegram both reach Session.command; neither is
    // in the room. `speak` is off by default precisely so they cannot talk to it.
    const { session, spoken } = mkTimers();
    await session.command("set a timer for 10 minutes");
    expect(spoken).toEqual([]);
  });
});
