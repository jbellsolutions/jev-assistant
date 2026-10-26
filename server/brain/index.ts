/** Which brain Jev has. With OPENROUTER_API_KEY: the lead (Luna 6 Pro) that the user talks to, with
 *  the AI SDK agent as its worker — or the agent alone when JEV_LEAD_MODEL=off. Without the key,
 *  none: every instant command still works, and anything that needs thinking says so. */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { Brain } from "../../core/brain.js";
import { createAgentBrain } from "./agent.js";
import { ChatStore } from "./chat-store.js";
import { DEFAULT_LEAD_MODEL, LeadBrain } from "./lead.js";
import { fileRunLog } from "./runlog.js";
import { TaskStore } from "./task-store.js";
import type { Hands } from "./tools.js";

export interface BrainWithHealth extends Brain {
  health(): Promise<{ ok: boolean; detail: string }>;
}

export function createBrain(env: NodeJS.ProcessEnv = process.env, opts: { spoken?: boolean; hands: Hands }): BrainWithHealth | null {
  if (env.OPENAI_API_KEY?.trim() && env.JEV_BRAIN_PROVIDER !== "openrouter") return createAgentBrain(env, opts);
  const leadModel = env.JEV_LEAD_MODEL?.trim() || DEFAULT_LEAD_MODEL;
  // JEV_CHAT_FILE: another file, or "off" for a chat that lives only as long as the process
  const file = env.JEV_CHAT_FILE?.trim();
  const chat = new ChatStore(file === "off" ? null : file || undefined);
  if (leadModel === "off") return createAgentBrain(env, { ...opts, chat });
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  const log = fileRunLog();
  // the worker keeps no chat of its own: the lead holds the conversation
  const worker = createAgentBrain(env, { ...opts, log, chat: new ChatStore(null) });
  if (!worker) return null;
  // An explicit provider instance, never a bare model string (that would route through Vercel's
  // gateway). Low effort: measured 2026-09-29, 2.3s to a short answer against 3.9s at medium.
  const effort = (env.JEV_LEAD_REASONING?.trim() || "low") as "low";
  const model = createOpenRouter({ apiKey }).chat(leadModel, { reasoning: { effort } });
  const tasks = new TaskStore(env.JEV_TASK_DIR?.trim() === "off" ? null : undefined);
  return new LeadBrain({ model, modelId: leadModel, worker, tasks, chat, spoken: opts.spoken, log });
}
