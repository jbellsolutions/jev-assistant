/** One append-only log per brain run: `~/.jev/runs/<date>/<runId>.jsonl`. It answers "where is it
 *  at, and what did it do?" with no infrastructure — every tool call with its arguments and result,
 *  every approval asked and answered, and exactly why the run stopped. Written by our own wrapper
 *  around the tools and the run, not by the SDK, so nothing a run does can skip it. */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type RunLogEntry =
  | { type: "start"; text: string; model: string; tools: string[] }
  | { type: "tool_start"; tool: string; input: unknown }
  | { type: "tool_end"; tool: string; ms: number; output: string; error: boolean }
  | { type: "ask"; summary: string }
  | { type: "answer"; ok: boolean }
  | { type: "steer"; text: string }
  /** A progress line the lead spoke mid-run. */
  | { type: "say"; text: string }
  /** Tools were taken away for the last step so the run ends in an answer. */
  | { type: "wrap_up"; found: number }
  | { type: "step"; n: number; text: string; finishReason: string; inputTokens?: number; outputTokens?: number }
  /** Why it stopped: answered, cap (too many steps), wall_clock, aborted, failed. */
  | { type: "end"; reason: "answered" | "wrapped_up" | "cap" | "wall_clock" | "aborted" | "failed" | "interrupted"; output: string; ms: number; steps: number; recording?: string };

export interface RunLog {
  write(runId: string, entry: RunLogEntry): void;
  /** The folder beside this run's log where its Mac actions are recorded (screenshots per action). */
  dirFor?(runId: string): string;
}

export const defaultRunsDir = () => path.join(process.env.JEV_HOME ?? path.join(homedir(), ".jev"), "runs");

/** Longest string kept per field: a run log is for reading, not for replaying a whole page. */
const MAX_FIELD = 4_000;

export function fileRunLog(dir = defaultRunsDir(), now: () => Date = () => new Date()): RunLog & { fileFor(runId: string): string } {
  const files = new Map<string, string>();
  const fileFor = (runId: string) => {
    let f = files.get(runId);
    if (!f) {
      const d = now();
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      f = path.join(dir, day, `${runId}.jsonl`);
      files.set(runId, f);
    }
    return f;
  };
  return {
    fileFor,
    dirFor: (runId: string) => fileFor(runId).replace(/\.jsonl$/, ""),
    write(runId, entry) {
      const file = fileFor(runId);
      try {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const clipped = JSON.stringify({ t: now().toISOString(), ...entry }, (_k, v) => (typeof v === "string" && v.length > MAX_FIELD ? `${v.slice(0, MAX_FIELD)}… (${v.length - MAX_FIELD} more)` : v));
        appendFileSync(file, `${clipped}\n`, { mode: 0o600 });
      } catch {
        /* a full disk must never break the run itself */
      }
    },
  };
}
