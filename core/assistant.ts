/** Shared desktop/voice/task contract. No credentials or provider SDKs cross this seam. */
export type WorkTarget = "local" | "cloud" | "orgo";
export const WORK_TARGET_LABELS: Record<WorkTarget, string> = { local: "My computer", cloud: "Jarvis browser", orgo: "Co-founder's computer" };
export type WorkStatus = "queued" | "running" | "waiting_for_user" | "paused" | "completed" | "failed" | "cancelled";
export interface WorkTask {
  id: string;
  goal: string;
  target: WorkTarget;
  status: WorkStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  progress: string;
  output: string;
  error?: string;
  approval?: { summary: string; requestId: string | null };
  providerRunId?: string;
  providerSessionId?: string;
  providerCursor?: number;
  providerBrowserId?: string;
  providerDeadlineAt?: number;
  dispatching?: boolean;
  requestId?: string;
  knownHosts?: string[];
  history: Array<{ at: number; text: string }>;
  attachments?: Array<{ id: string; name: string }>;
}
export interface AssistantStatus {
  tasks: WorkTask[];
  connections: { openai: boolean; livekit: boolean; browserUse: boolean; typesafe: boolean; chrome: boolean; computer: boolean; orgo?: boolean; composio?: boolean };
  voiceWorker: "off" | "starting" | "running" | "error";
  voiceError?: string;
}
export interface AssistantCommand {
  context?: string;
  text: string;
  target: WorkTarget;
  requestId?: string;
  attachments?: Array<{ id: string; name: string }>;
}
