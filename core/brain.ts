/** The brain lane: anything that is not a direct browser or Mac action goes to a model behind
 *  Jev that can answer, reason and draft — it never itself clicks, types or opens anything;
 *  Jev's own fast lane does that. This file is the pure seam; a concrete implementation (e.g.
 *  server/brain/openrouter.ts) lives outside core so core/ stays host-free. */

/** What the assistant may answer an approval request with. Which ones a given request accepts
 *  arrives with the request (`choices`); anything not offered degrades to "once". */
export type ApprovalChoice = "once" | "session" | "always" | "deny";

export type BrainEvent =
  /** A chunk of the assistant's reply, streamed as it is written. */
  | { kind: "delta"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_start"; tool: string; preview: string }
  | { kind: "tool_end"; tool: string; durationMs: number; error: boolean }
  /** The agent wants a human to allow something; the run waits until approve() is called. */
  | { kind: "approval"; requestId: string | null; summary: string; choices: ApprovalChoice[] }
  | { kind: "approved"; choice: string }
  | { kind: "steered" }
  /** A short progress line the lead wants spoken now ("I'm in the org — opening External Client
   *  Apps"), while the run carries on. Not the answer: that is `completed`. */
  | { kind: "say"; text: string }
  | { kind: "completed"; output: string }
  /** `providerFailure`: the model provider rejected the request OR broke serving it — as opposed to
   *  the TASK failing, which is the agent's honest answer and must never be retried away. Worth one
   *  retry, and a fresh conversation if it keeps happening. */
  | { kind: "failed"; error: string; providerFailure?: boolean }
  /** Emitted by the session, not the agent: the utterance was re-sent after a provider failure. */
  | { kind: "retrying"; attempt: number; fresh: boolean }
  | { kind: "cancelled" };

export type BrainTerminal = Extract<BrainEvent, { kind: "completed" | "failed" | "cancelled" }>;

export interface BrainRun {
  id: string;
  /** Ends with exactly one terminal event (completed / failed / cancelled), even when the
   *  underlying stream dropped: the client then polls the run's status until it settles. */
  events: AsyncIterable<BrainEvent>;
}

export interface Brain {
  readonly name: string;
  /** Start a run for one utterance in the assistant's persistent conversation. `fresh` sends this
   *  one request without the conversation in view; the conversation itself is kept. */
  /** `attachments`: files the user dropped on the panel with this message (ids in the attachment store). */
  send(text: string, opts?: { signal?: AbortSignal; fresh?: boolean; from?: "cofounder"; attachments?: Array<{ id: string; name: string }> }): Promise<BrainRun>;
  /** Begin a new conversation ("new chat"); the next send() starts from a clean thread. */
  reset(): Promise<void>;
  /** Something Jev did straight away, without a run ("open Slack" → "Opened Slack"), kept in the
   *  conversation so a follow-up question has it in view. */
  remember?(user: string, outcome: string): void;
  approve(runId: string, choice: ApprovalChoice, requestId?: string | null): Promise<void>;
  /** Add to a run already in progress ("also check the second result"). */
  steer(runId: string, text: string): Promise<void>;
  stop(runId: string): Promise<void>;
}

/** Did the model provider reject the request, or break while serving it — as opposed to the TASK
 *  failing? Those are worth a retry and, if persistent, a fresh thread.
 *
 *  This used to be `isModelError` and matched **4xx only**, which is why a five-day-old conversation
 *  survived an outage: Hermes forwarded `HTTP 500: Internal Server Error` from ollama.com, that failed
 *  this test, and `core/session.ts` took the "the task failed" branch — which RESETS the failure
 *  counter, so repeated 500s could never reach the rotation threshold. The whole retry-and-rotate
 *  ladder was unreachable for every 5xx and every transport error.
 *
 *  The line that must stay sharp: an agent reporting that the work failed ("couldn't find the page")
 *  is not a provider failure, and retrying it would throw away an honest answer. So this matches
 *  transport and HTTP wording, never task wording — and deliberately NOT a bare "timed out", which a
 *  browser step says about itself. */
export function isProviderFailure(error: string): boolean {
  return /\b[45]\d\d\b|bad request|invalid_request|context length|too many tokens|maximum context|max_retries_exhausted|streaming failed|internal server error|bad gateway|service unavailable|gateway timeout|econnreset|etimedout|socket hang up|fetch failed|network error/i.test(
    error,
  );
}

/** Map a typed reply to a pending approval onto what the request allows. */
export function approvalChoice(reply: "confirm" | "cancel", raw: string, offered: ApprovalChoice[]): ApprovalChoice {
  if (reply === "cancel") return "deny";
  const t = raw.toLowerCase();
  if (/\balways\b|\bpermanently\b|\bfrom now on\b|\bevery time\b/.test(t) && offered.includes("always")) return "always";
  if (/\bsession\b|\bfor now\b|\bthis time around\b|\buntil i say\b/.test(t) && offered.includes("session")) return "session";
  return "once";
}
