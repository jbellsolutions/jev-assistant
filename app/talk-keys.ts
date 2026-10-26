/** Runs `native/jev-keys` and turns its lines into talk-key events. The helper is a listen-only
 *  event tap; macOS gates it behind Input Monitoring, granted once to the helper itself. Until then
 *  it reports that and exits, and this keeps retrying slowly so the key starts working as soon as
 *  the user clicks Allow — no restart of Jev needed. */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

export type TalkKeyStatus = "ready" | "needs-permission" | "missing" | "failed";

export interface TalkKeysOptions {
  bin: string;
  combo: string;
  onEvent: (event: "down" | "up" | "cancel") => void;
  onStatus: (status: TalkKeyStatus, detail?: string) => void;
}

/** How the combo reads to a human: "fn+control" → "Fn+Control". */
export function comboLabel(combo: string): string {
  return combo
    .split("+")
    .map((k) => (k.toLowerCase() === "fn" ? "Fn" : k.charAt(0).toUpperCase() + k.slice(1).toLowerCase()))
    .join("+");
}

export function startTalkKeys(opts: TalkKeysOptions): { stop(): void } {
  let child: ChildProcess | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = (ms: number) => {
    if (!stopped) timer = setTimeout(run, ms);
  };
  function run(): void {
    if (!existsSync(opts.bin)) return opts.onStatus("missing", opts.bin);
    let permission = false;
    child = spawn(opts.bin, [opts.combo], { stdio: ["ignore", "pipe", "pipe"] });
    createInterface({ input: child.stdout! }).on("line", (raw) => {
      const line = raw.trim();
      if (line === "ready") opts.onStatus("ready");
      else if (line === "down" || line === "up" || line === "cancel") opts.onEvent(line);
      else if (line === "error: input-monitoring") {
        permission = true;
        opts.onStatus("needs-permission");
      } else if (line.startsWith("error:")) opts.onStatus("failed", line.slice(6).trim());
    });
    child.on("error", (err) => opts.onStatus("failed", err.message));
    child.on("exit", () => {
      child = null;
      // waiting on Allow: look again every few seconds; crashed: back off harder
      later(permission ? 4_000 : 15_000);
    });
  }
  run();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      child?.kill("SIGTERM");
    },
  };
}
