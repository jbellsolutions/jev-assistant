/** Small persistent state for the assistant (`~/.jev/state.json`, mode 0600): settings that must
 *  survive a relaunch. Missing or corrupt → empty. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { SttMode } from "../core/protocol.js";

export interface JevState {
  /** How the user last chose to be heard. Server-side rather than in the renderer, so the choice
   *  survives a relaunch and the panel has nothing to persist of its own. */
  listenMode?: SttMode;
  /** the user's mute: nothing is spoken while true. Remembered, so a relaunch doesn't start talking. */
  muted?: boolean;
  /** Who his words go to: Jev, or straight to the co-founder. Remembered across a relaunch. */
  talkingTo?: "jev" | "cofounder";
}

export const defaultStatePath = () => path.join(process.env.JEV_HOME ?? path.join(homedir(), ".jev"), "state.json");

export function readState(file = defaultStatePath()): JevState {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JevState) : {};
  } catch {
    return {};
  }
}

export function writeState(patch: Partial<JevState>, file = defaultStatePath()): JevState {
  const next = { ...readState(file), ...patch };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return next;
}
