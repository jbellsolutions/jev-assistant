import { TypeSafeClient, choice } from "@typesafe-ai/sdk";
import type { WorkTask } from "../../core/assistant.js";
export type Intent = "task" | "status" | "pause" | "cancel" | "resume" | "correction";
export function createRequestRouter(env: NodeJS.ProcessEnv) {
  const client = env.TYPESAFE_API_KEY?.trim() ? new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY, logLevel: "warn" }) : null;
  return async (text: string, current: WorkTask | undefined): Promise<Intent> => {
    if (/^(?:what(?:'s| is) (?:the )?(?:task )?status|task status|how(?:'s| is) it going)\??$/i.test(text.trim())) return "status";
    if (/^(?:pause|cancel|resume)(?: (?:the |this |current )?task)?[.!]?$/i.test(text.trim())) return text.trim().split(/\W/)[0]!.toLowerCase() as Intent;
    if (!client || !current) return "task";
    try {
      const r = await client.systemOne({ state: { request: text, current_task: { goal: current.goal, status: current.status } }, questions: {
        intent: choice("What is the user asking relative to the current task? Choose task for a new independent goal or no match.", {
          task: "A new independent request", status: "Ask about progress", pause: "Temporarily stop the current task", cancel: "Cancel the current task", resume: "Continue a paused task", correction: "Change or add a requirement to the current task",
        }),
      } }, { timeout: 5000 });
      const a = r.answers.intent;
      return a.confidence >= 0.8 ? a.choice as Intent : "task";
    } catch { return "task"; }
  };
}
