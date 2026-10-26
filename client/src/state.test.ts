import { describe, expect, it } from "vitest";
import type { DecisionSummary, ServerMessage } from "../../core/protocol.ts";
import { type Event, type State, initialState, reducer } from "./state.ts";

const run = (events: Event[], from: State = initialState) => events.reduce(reducer, from);

const decision: DecisionSummary = {
  command: "click on pricing", intent: "click", intentConfidence: 0.9, action: { kind: "click", elementId: "e2", label: 'link "Pricing"' },
  actionLabel: 'Click link "Pricing"', source: "jev", model: "jev-1.13.0", latencyMs: 120, inputTokens: 300,
};

describe("reducer: brain events", () => {
  const hermes: DecisionSummary = { ...decision, command: "what's on my calendar", intent: "unclear", route: "hermes", routeConfidence: 0.9, action: { kind: "none", reason: "" }, actionLabel: "Ask Hermes" };
  const start: Event[] = [
    { type: "transcript_ack", text: "what's on my calendar", stepId: 7 },
    { type: "decision", decision: hermes },
    { type: "status", text: "Hermes is on it", level: "ok" },
    { type: "transcript_ack", text: "scroll down", stepId: 8 },
    { type: "status", text: "Scrolled down", level: "ok" },
  ];

  it("says when a failure was the provider's, not Jev's and not the task's", () => {
    // The live line the user saw was `Brain: HTTP 500: Internal Server Error (ref: …)`, which reads as
    // if his request was the problem. It was an upstream outage.
    const provider = reducer(initialState, { type: "brain_event", stepId: 1, runId: "r", event: { kind: "failed", error: "HTTP 500: Internal Server Error (ref: abc)", providerFailure: true } });
    expect(provider.status?.text).toBe("Brain: the model provider failed — HTTP 500: Internal Server Error (ref: abc)");

    // a genuine task failure is the assistant's own answer and must not be dressed up as an outage
    const task = reducer(initialState, { type: "brain_event", stepId: 1, runId: "r", event: { kind: "failed", error: "I could not find that channel" } });
    expect(task.status?.text).toBe("Brain: I could not find that channel");
  });

  it("attaches streamed text and tools to the step's entry, not the latest one", () => {
    const s = run([
      ...start,
      { type: "brain_event", stepId: 7, runId: "run_1", event: { kind: "tool_start", tool: "gcal", preview: "today" } },
      { type: "brain_event", stepId: 7, runId: "run_1", event: { kind: "tool_end", tool: "gcal", durationMs: 400, error: false } },
      { type: "brain_event", stepId: 7, runId: "run_1", event: { kind: "delta", text: "Two " } },
      { type: "brain_event", stepId: 7, runId: "run_1", event: { kind: "delta", text: "meetings" } },
    ]);
    expect(s.entries[0]!.brain).toBeUndefined();
    expect(s.entries[1]!.brain).toEqual({ runId: "run_1", text: "Two meetings", tools: [{ tool: "gcal", preview: "today", durationMs: 400, error: false }], state: "running" });
    const done = reducer(s, { type: "brain_event", stepId: 7, runId: "run_1", event: { kind: "completed", output: "Two meetings today.\nStandup at 9." } });
    expect(done.entries[1]!.brain?.state).toBe("completed");
    expect(done.entries[1]!.result).toEqual({ text: "Two meetings today.", level: "ok" });
    expect(done.status).toEqual({ text: "Brain: done", level: "ok" });
  });

  it("a retry starts the run's text over and says so, keeping the tool record", () => {
    const s = run([
      ...start,
      { type: "brain_event", stepId: 7, runId: "run_1", event: { kind: "tool_start", tool: "gcal", preview: "today" } },
      { type: "brain_event", stepId: 7, runId: "run_1", event: { kind: "delta", text: "Two " } },
      { type: "brain_event", stepId: 7, runId: "run_1", event: { kind: "failed", error: "HTTP 400 Bad Request", providerFailure: true } },
      { type: "brain_event", stepId: 7, runId: "run_2", event: { kind: "retrying", attempt: 2, fresh: false } },
    ]);
    expect(s.entries[1]!.brain).toMatchObject({ runId: "run_2", text: "", state: "running", retries: 1, fresh: false, tools: [{ tool: "gcal" }] });
    expect(s.entries[1]!.result).toEqual({ text: "Retrying…", level: "warn" });
    expect(s.status).toEqual({ text: "Brain: retrying…", level: "warn" });
    const fresh = reducer(s, { type: "brain_event", stepId: 7, runId: "run_3", event: { kind: "retrying", attempt: 3, fresh: true } });
    expect(fresh.entries[1]!.brain).toMatchObject({ runId: "run_3", retries: 2, fresh: true });
    expect(fresh.status.text).toBe("Brain: retrying in a fresh conversation…");
  });

  it("raises and clears the approval card", () => {
    const s = run([...start, { type: "brain_event", stepId: 7, runId: "run_1", event: { kind: "approval", requestId: "r1", summary: "read your calendar", choices: ["once", "deny"] } }]);
    expect(s.approval).toEqual({ runId: "run_1", question: "Jev wants to read your calendar. Allow it?", choices: ["once", "deny"] });
    expect(s.entries[1]!.brain?.state).toBe("waiting");
    // a browser question and outcome live in their own slot; the brain's own events clear the approval
    const both = reducer(s, { type: "confirm", actionLabel: "Click Delete", reason: "risky" });
    expect(both.pending?.kind).toBe("confirm");
    expect(both.approval?.runId).toBe("run_1");
    expect(reducer(both, { type: "status", text: "Cancelled: Click Delete", level: "warn" })).toMatchObject({ pending: null, approval: { runId: "run_1" } });
    expect(reducer(s, { type: "brain_event", stepId: 7, runId: "run_1", event: { kind: "approved", choice: "once" } }).approval).toBeNull();
    expect(reducer(s, { type: "brain_event", stepId: 7, runId: "run_1", event: { kind: "failed", error: "boom" } })).toMatchObject({ approval: null, status: { level: "error" } });
    expect(reducer(s, { type: "dismiss_approval" }).approval).toBeNull();
  });
});

describe("reducer", () => {
  it("tracks connection and hello", () => {
    const s = run([{ type: "socket", connected: true }, { type: "hello", jev: { enabled: true, model: "jev-latest" }, viewport: { width: 1000, height: 600 } }]);
    expect(s.connected).toBe(true);
    expect(s.jev?.model).toBe("jev-latest");
    expect(s.viewport).toEqual({ width: 1000, height: 600 });
  });

  it("builds a log entry from transcript → decision → outcome", () => {
    const s = run([
      { type: "transcript_ack", text: "click on pricing", stepId: 1 },
      { type: "decision", decision },
      { type: "status", text: "Clicking…", level: "busy" },
      { type: "status", text: 'Clicked link "Pricing"', level: "ok" },
    ]);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ said: "click on pricing", decision, result: { text: 'Clicked link "Pricing"', level: "ok" } });
    expect(s.status.level).toBe("ok");
  });

  it("does not overwrite an entry's outcome with later statuses", () => {
    const s = run([
      { type: "transcript_ack", text: "go back", stepId: 2 },
      { type: "status", text: "Went back", level: "ok" },
      { type: "status", text: "Something else", level: "warn" },
    ]);
    expect(s.entries[0]?.result?.text).toBe("Went back");
  });

  it("opens a confirmation and closes it on the next outcome", () => {
    let s = run([{ type: "transcript_ack", text: "click delete", stepId: 3 }, { type: "confirm", actionLabel: "Click Delete", reason: "risky" }]);
    expect(s.pending).toMatchObject({ kind: "confirm", actionLabel: "Click Delete" });
    s = reducer(s, { type: "status", text: "Cancelled: Click Delete", level: "warn" });
    expect(s.pending).toBeNull();
  });

  it("opens a clarification and drops it when a new command arrives", () => {
    const options = [{ elementId: "e1", label: "a", probability: 0.5 }];
    let s = run([{ type: "transcript_ack", text: "click choose", stepId: 4 }, { type: "clarify", question: "Which one?", options }]);
    expect(s.pending).toMatchObject({ kind: "clarify", options });
    s = reducer(s, { type: "transcript_ack", text: "the second one", stepId: 5 });
    expect(s.pending).toBeNull();
    expect(s.entries).toHaveLength(2);
  });

  it("caps the log and clears it", () => {
    let s = initialState;
    for (let i = 0; i < 50; i++) s = reducer(s, { type: "transcript_ack", text: `cmd ${i}`, stepId: i + 1 });
    expect(s.entries).toHaveLength(40);
    expect(s.entries[0]?.said).toBe("cmd 49");
    expect(reducer(s, { type: "clear_log" }).entries).toEqual([]);
  });
});

describe("multi-step utterances", () => {
  it("makes one entry per step, each carrying its step info, and applies outcomes to the latest", () => {
    let s = initialState;
    const original = "open a.com and open b.com";
    s = reducer(s, { type: "steps", original, commands: ["open a.com", "open b.com"] });
    s = reducer(s, { type: "transcript_ack", text: "open a.com", stepId: 7, step: { index: 0, total: 2, original } });
    s = reducer(s, { type: "status", text: "Opened https://a.com", level: "ok" });
    s = reducer(s, { type: "transcript_ack", text: "open b.com", stepId: 8, step: { index: 1, total: 2, original } });
    s = reducer(s, { type: "status", text: "Opened https://b.com", level: "ok" });
    expect(s.entries.map((e) => e.said)).toEqual(["open b.com", "open a.com"]);
    expect(s.entries[0]!.step).toEqual({ index: 1, total: 2, original });
    expect(s.entries[0]!.result?.text).toBe("Opened https://b.com");
    expect(s.entries[1]!.result?.text).toBe("Opened https://a.com");
  });

  it("attaches a late verify to the step it belongs to, not the newest entry with that text", () => {
    let s = initialState;
    const verify = { done: false, stuck: true, doneProbability: 0, blocker: "no_change", source: "heuristic", latencyMs: 0, text: "stuck: no change" } as const;
    s = reducer(s, { type: "transcript_ack", text: "scroll down", stepId: 1 });
    s = reducer(s, { type: "transcript_ack", text: "scroll down", stepId: 2 });
    s = reducer(s, { type: "verify", stepId: 1, command: "scroll down", verify });
    expect(s.entries[1]!.verify).toEqual(verify);
    expect(s.entries[0]!.verify).toBeUndefined();
  });
});

describe("timers and speaking in the panel", () => {
  it("holds the running timers and lets the panel count down itself", () => {
    // dueAt is absolute on purpose: the server never ticks, so the display cannot drift from the
    // alarm that will actually fire, and a Mac that was asleep shows the right number on wake.
    const s = run([{ type: "timers", timers: [{ id: 1, dueAt: 1_700_000_000_000, label: "call Bob" }] }]);
    expect(s.timers).toEqual([{ id: 1, dueAt: 1_700_000_000_000, label: "call Bob" }]);
    expect(run([{ type: "timers", timers: [] }]).timers).toEqual([]);
  });

  it("tracks whether Jev is speaking", () => {
    expect(run([{ type: "speaking", active: true }]).speaking).toBe(true);
    expect(run([{ type: "speaking", active: true }, { type: "speaking", active: false }]).speaking).toBe(false);
  });

  it("starts with neither", () => {
    expect(run([]).timers).toEqual([]);
    expect(run([]).speaking).toBe(false);
  });
});

describe("the voice indicator", () => {
  it("is unknown until the server says, then carries what it said", () => {
    expect(initialState.voice).toBeNull();
    const s = run([
      { type: "hello", jev: { enabled: true, model: null }, viewport: { width: 1000, height: 600 }, voice: { on: true, detail: "fish (s2.1-pro-free, via ffplay)" } },
    ]);
    expect(s.voice).toEqual({ on: true, detail: "fish (s2.1-pro-free, via ffplay)" });
  });

  it("keeps saying so when the voice is off — silence with a reason, not silence", () => {
    const s = run([
      { type: "hello", jev: { enabled: true, model: null }, viewport: { width: 1000, height: 600 }, voice: { on: false, detail: "off (set FISH_AUDIO_API_KEY or ELEVENLABS_API_KEY to give Jev a voice)" } },
    ]);
    expect(s.voice?.on).toBe(false);
    expect(s.voice?.detail).toMatch(/FISH_AUDIO_API_KEY/);
  });

  it("follows the output device when the server says it changed", () => {
    const s = run([
      { type: "hello", jev: { enabled: true, model: null }, viewport: { width: 1000, height: 600 }, voice: { on: true, detail: "fish (x, via ffplay)", device: "Soundcore Headphones" } },
      { type: "voice", voice: { on: true, detail: "fish (x, via ffplay)", device: "Mac mini Speakers" } },
    ]);
    expect(s.voice?.device).toBe("Mac mini Speakers");
  });

  it("keeps what it has when an older server sends no voice block", () => {
    const s = run([
      { type: "hello", jev: { enabled: true, model: null }, viewport: { width: 1000, height: 600 }, voice: { on: true, detail: "fish (x, via ffplay)" } },
      { type: "hello", jev: { enabled: true, model: null }, viewport: { width: 1000, height: 600 } },
    ]);
    expect(s.voice?.on).toBe(true);
  });
});

describe("the listening switch", () => {
  it("starts on the button and takes the server's remembered choice from hello", () => {
    expect(initialState.listen).toEqual({ mode: "push", wakeAvailable: false });
    const s = run([{ type: "hello", jev: { enabled: true, model: "jev-latest" }, viewport: { width: 1000, height: 600 }, listen: { mode: "wake", wakeAvailable: true } }]);
    expect(s.listen).toEqual({ mode: "wake", wakeAvailable: true });
  });

  it("answers the click before the server has confirmed it", () => {
    const s = run([
      { type: "hello", jev: { enabled: true, model: null }, viewport: { width: 1000, height: 600 }, listen: { mode: "push", wakeAvailable: true } },
      { type: "listen_mode_local", mode: "wake" },
    ]);
    expect(s.listen).toEqual({ mode: "wake", wakeAvailable: true });
  });

  it("keeps the current choice when an older server sends no listen block", () => {
    const s = run([
      { type: "hello", jev: { enabled: true, model: null }, viewport: { width: 1000, height: 600 }, listen: { mode: "wake", wakeAvailable: true } },
      { type: "hello", jev: { enabled: true, model: null }, viewport: { width: 1000, height: 600 } },
    ]);
    expect(s.listen.mode).toBe("wake");
  });
});

describe("the big pane: Jev's browser or your screen", () => {
  const hello = (browserView: string | null) => ({ type: "hello" as const, jev: { enabled: true, model: "m" }, viewport: { width: 1, height: 1 }, browserView });
  const tool = (runId: string, name: string) => ({ type: "brain_event" as const, stepId: 1, runId, event: { kind: "tool_start" as const, tool: name, preview: "" } });

  it("opens on Jev's browser when there is one, and on the screen when there is not", () => {
    expect(reducer(initialState, hello("http://127.0.0.1:3000/v1/sessions/debug")).pane.tab).toBe("browser");
    expect(reducer(initialState, hello(null)).pane.tab).toBe("screen");
  });

  it("follows the brain: browser_box shows Jev's browser, Mac and Chrome work shows the screen, connectors leave it", () => {
    let s = reducer(initialState, hello("http://x/"));
    s = reducer(s, tool("r1", "mac_read"));
    expect(s.pane.tab).toBe("screen");
    s = reducer(s, tool("r1", "browser_box"));
    expect(s.pane.tab).toBe("browser");
    s = reducer(s, tool("r1", "SLACK_SEND_MESSAGE"));
    expect(s.pane.tab).toBe("browser");
  });

  it("a tab picked by hand stays until the next run starts", () => {
    let s = reducer(initialState, hello("http://x/"));
    s = reducer(s, tool("r1", "browser_box"));
    s = reducer(s, { type: "pane_tab", tab: "screen" });
    s = reducer(s, tool("r1", "browser_box"));
    expect(s.pane.tab).toBe("screen");
    s = reducer(s, tool("r2", "browser_box"));
    expect(s.pane.tab).toBe("browser");
  });

  it("never switches to a browser that is not there", () => {
    let s = reducer(initialState, hello(null));
    s = reducer(s, tool("r1", "browser_box"));
    expect(s.pane.tab).toBe("screen");
  });
});

describe("notices", () => {
  it("a late reply is its own log entry, never the result of the last command", async () => {
    const { reducer, initialState } = await import("./state.ts");
    let s = reducer(initialState, { type: "transcript_ack", stepId: 1, text: "open slack" } as never);
    s = reducer(s, { type: "notice", from: "↩ The co-founder replied", text: "Done: 3 competitors.", level: "ok" } as never);
    expect(s.entries).toHaveLength(2);
    expect(s.entries[1]!.result).toBeNull();
    expect(s.entries[0]).toMatchObject({ said: "↩ The co-founder replied", result: { text: "Done: 3 competitors.", level: "ok" } });
    // what the command goes on to do still lands on the command, not on the reply above it
    s = reducer(s, { type: "decision", decision: { command: "open slack" } } as never);
    s = reducer(s, { type: "status", text: "Opened Slack", level: "ok" } as never);
    expect(s.entries[1]).toMatchObject({ said: "open slack", decision: { command: "open slack" }, result: { text: "Opened Slack" } });
    expect(s.entries[0]!.decision).toBeNull();
  });
});

describe("the co-founder tab", () => {
  it("follows a hand-off to the co-founder only when its computer is connected", async () => {
    const { reducer, initialState } = await import("./state.ts");
    const start = (s: typeof initialState) => reducer(s, { type: "brain_event", stepId: 1, runId: "r1", event: { kind: "tool_start", tool: "cofounder", input: {} } } as never);
    const off = reducer(initialState, { type: "hello", jev: { enabled: true, model: "m" }, viewport: { width: 1, height: 1 }, cofounder: { off: "needs key" } } as never);
    expect(start(off).pane.tab).not.toBe("cofounder");
    const on = reducer(initialState, { type: "hello", jev: { enabled: true, model: "m" }, viewport: { width: 1, height: 1 }, cofounder: { computer: "c" } } as never);
    expect(start(on).pane.tab).toBe("cofounder");
  });
});

describe("the transcript across a restart of Jev", () => {
  const said = (text: string, stepId: number): ServerMessage => ({ type: "transcript_ack", text, stepId });
  it("comes back marked as earlier, and a new launch's step 1 never lands on the old step 1", () => {
    let before = reducer(initialState, said("check Slack", 1));
    before = reducer(before, { type: "brain_event", stepId: 1, runId: "r1", event: { kind: "delta", text: "Looking…" } });
    const saved = JSON.parse(JSON.stringify(before.entries)); // what the window stored

    let after = reducer(initialState, { type: "restore_log", entries: saved });
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]).toMatchObject({ said: "check Slack", past: true, brain: { state: "cancelled" }, result: { text: "Stopped — Jev restarted" } });

    // an event for this launch's step 1 before its entry exists must not touch the old step 1
    after = reducer(after, { type: "brain_event", stepId: 1, runId: "r0", event: { kind: "delta", text: "X" } });
    after = reducer(after, { type: "verify", stepId: 1, verify: { ok: true } } as never);
    expect(after.entries[0]!.brain?.text).toBe("Looking…");
    expect(after.entries[0]!.verify).toBeUndefined();

    after = reducer(after, said("what time is it", 1)); // step ids start over
    after = reducer(after, { type: "brain_event", stepId: 1, runId: "r2", event: { kind: "completed", output: "Ten past ten." } });
    after = reducer(after, { type: "status", text: "Done", level: "ok" });
    expect(after.entries.map((e) => [e.said, !!e.past])).toEqual([["what time is it", false], ["check Slack", true]]);
    expect(after.entries[0]!.brain?.text).toBe("Ten past ten.");
    expect(after.entries[1]!.brain?.text).toBe("Looking…"); // untouched
    expect(new Set(after.entries.map((e) => e.id)).size).toBe(2);
  });

  it("a status with only earlier entries doesn't rewrite one of them", () => {
    const after = reducer(reducer(initialState, { type: "restore_log", entries: [{ id: 1, said: "open slack", decision: null, result: null }] }), { type: "status", text: "Ready", level: "ok" });
    expect(after.entries[0]!.result).toBeNull();
  });

  it("ignores storage that isn't a list of entries", () => {
    expect(reducer(initialState, { type: "restore_log", entries: { nope: 1 } }).entries).toEqual([]);
    expect(reducer(initialState, { type: "restore_log", entries: [null, 3, { said: "ok", id: 9, decision: null, result: null }] }).entries).toHaveLength(1);
  });

  it("marks the command that started a new chat, and only that one", () => {
    let s = reducer(initialState, said("check Slack", 1));
    s = reducer(s, said("new chat", 2));
    s = reducer(s, { type: "new_chat", stepId: 2 });
    expect(s.entries.map((e) => [e.said, !!e.newChat])).toEqual([["new chat", true], ["check Slack", false]]);
    expect(reducer(s, { type: "new_chat", stepId: 99 })).toBe(s);
  });

  it("puts a late reply at the top, where new things go", () => {
    let s = reducer(initialState, said("hand this to the co-founder", 1));
    s = reducer(s, { type: "notice", from: "↩ The co-founder replied", text: "Done.", level: "ok" });
    expect(s.entries[0]!.said).toBe("↩ The co-founder replied");
  });
});


describe("talking to the co-founder", () => {
  it("follows the switch, from hello and from the switch message", () => {
    let s = reducer(initialState, { type: "hello", jev: { enabled: true, model: "m" }, viewport: { width: 1, height: 1 }, talkingTo: "cofounder" });
    expect(s.talkingTo).toBe("cofounder");
    s = reducer(s, { type: "talking_to", to: "jev" });
    expect(s.talkingTo).toBe("jev");
  });

  it("keeps the chat, or why it couldn't be read", () => {
    const d = { id: "a", sender: "user", recipient: "default", state: "complete", body: "hi", result: "hello", created: 1 };
    expect(reducer(initialState, { type: "cofounder_history", exchanges: [d] }).cofounderHistory).toEqual({ exchanges: [d] });
    expect(reducer(initialState, { type: "cofounder_history", error: "no" }).cofounderHistory).toEqual({ error: "no" });
  });
});
