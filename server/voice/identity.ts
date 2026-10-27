import { createHash } from "node:crypto";
/** Shared projects must dispatch to this installation's companion, not another Mac's worker. */
export function voiceAgentName(env: NodeJS.ProcessEnv): string {
  return env.JEV_TOKEN ? `jarvis-${createHash("sha256").update(env.JEV_TOKEN).digest("hex").slice(0, 16)}` : "jev-assistant";
}
