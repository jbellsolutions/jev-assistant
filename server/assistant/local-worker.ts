import { createOpenAI } from "@ai-sdk/openai";
import type { WorkTask } from "../../core/assistant.js";
import type { ApprovalChoice, Brain } from "../../core/brain.js";
import { AgentBrain, CAP_LINE, WALL_LINE, type JobEnd } from "../brain/agent.js";
import { ChatStore } from "../brain/chat-store.js";
import { brainInstructions } from "../brain/instructions.js";
import type { Hands } from "../brain/tools.js";
import type { TaskWorker, WorkContext } from "./tasks.js";
import { createComposioApps } from "../brain/apps.js";

export function workerEnvironment(target: WorkTask["target"], hands: Hands) {
  return target === "orgo" ? {
    hands: { mac: null, chrome: null, computer: null, orgo: hands.orgo, cofounder: hands.cofounder }, ownTools: ["orgo"],
    instruction: "This task is assigned ONLY to the co-founder's Orgo computer. Use orgo screenshots and actions there. Never use the user's Mac, Chrome, local shell or another computer. Do not hand work to a separate agent. Connected app tools are available for the requested app tasks.",
  } : {
    hands: { ...hands, box: null, orgo: null, cofounder: null }, ownTools: ["mac_read", "mac_act", "mac_control", "chrome", "shell", "secret"],
    instruction: "This task is assigned to the user's local computer and connected apps. Use Chrome through the existing extension, the Mac accessibility driver, or connected app tools. Never switch to another computer or cloud browser.",
  };
}

export class LocalWorker implements TaskWorker {
  private running = new Map<string, { brain: Brain; runId: string }>();
  constructor(private readonly opts: { env: NodeJS.ProcessEnv; hands: Hands; createBrain?: (task: WorkTask) => Brain }) {}
  async run(task: WorkTask, ctx: WorkContext): ReturnType<TaskWorker["run"]> {
    if (!this.opts.createBrain && !this.opts.env.OPENAI_API_KEY?.trim()) throw new Error("Connect your OpenAI API key in Settings to enable Luna's local task worker. Instant controls remain available.");
    if (task.target === "orgo" && !this.opts.hands.orgo) throw new Error("Connect Orgo and choose its computer in Settings before using the co-founder's computer.");
    const environment = workerEnvironment(task.target, this.opts.hands);
    const brain = this.opts.createBrain?.(task) ?? new AgentBrain({
      model: createOpenAI({ apiKey: this.opts.env.OPENAI_API_KEY }).responses(this.opts.env.JEV_BRAIN_MODEL || "gpt-6-luna"),
      modelId: this.opts.env.JEV_BRAIN_MODEL || "gpt-6-luna", provider: "OpenAI", hands: environment.hands, ownTools: environment.ownTools,
      chat: new ChatStore(null), apps: createComposioApps(this.opts.env),
      instructions: () => `${brainInstructions()}\n${environment.instruction}\nPrefer connected app APIs when the relevant action is available. Respect approval requests. Verify important outcomes from returned IDs or observed page state. If resuming, inspect current state and avoid repeating completed actions. Finish the requested multi-step goal or explain the concrete blocker honestly.`,
      limits: { maxSteps: 60, maxWallMs: 15 * 60000 },
    });
    let reason: JobEnd["reason"] | undefined;
    const hosts = [...(task.knownHosts ?? [])];
    const text = `Task: ${task.goal}\n${task.history.length ? `Earlier progress (may include interrupted actions; verify before proceeding):\n${task.history.slice(-12).map((h) => h.text).join("\n")}\nEarlier output: ${task.output.slice(-5000)}` : ""}`;
    const options = { signal: ctx.signal, attachments: task.attachments };
    const run = brain instanceof AgentBrain ? await brain.send(text, { ...options, job: {
      brief: "Work on this saved task and preserve accurate observations.",
      tab: /\b(?:current|this|active) (?:tab|page)|\bin front\b/i.test(task.goal) ? "his_tab" : "background",
      onEnd: (end) => { reason = end.reason; }, hosts: () => hosts,
      onPage: (url) => { try { const host = new URL(url).hostname; if (!hosts.includes(host)) { hosts.push(host); ctx.update({ knownHosts: hosts.slice(-100) }); } } catch {} },
    } }) : await brain.send(text, options);
    this.running.set(task.id, { brain, runId: run.id });
    try {
      let output: string | undefined;
      for await (const e of run.events) {
        ctx.event(e);
        if (e.kind === "failed") throw new Error(e.error);
        if (e.kind === "cancelled") throw new Error("Task interrupted");
        if (e.kind === "completed") output = e.output;
      }
      if (output === undefined) throw new Error("The worker ended without a final result");
      if (reason && reason !== "answered" || output.includes(CAP_LINE) || output.includes(WALL_LINE)) return { output, status: "paused", progress: "The worker reached a limit. Review partial results, then resume to continue." };
      return output;
    } finally { this.running.delete(task.id); }
  }
  async approve(id: string, choice: ApprovalChoice, requestId: string | null): Promise<void> {
    const r = this.running.get(id); if (!r) throw new Error("The local worker is no longer waiting");
    await r.brain.approve(r.runId, choice, requestId);
  }
  async cancel(task: WorkTask): Promise<void> { const r = this.running.get(task.id); if (r) await r.brain.stop(r.runId); }
}
