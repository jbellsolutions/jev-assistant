import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { VoiceLeases } from "../server/assistant/voice-leases.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const home = () => { const dir = mkdtempSync(path.join(tmpdir(), "jev-leases-")); dirs.push(dir); return dir; };
const room = "jev-00000000-0000-4000-8000-000000000000";
it("preserves only owned room IDs across crashes and removes confirmed closed rooms", () => {
  const dir = home(); const leases = new VoiceLeases(dir);
  leases.add(room); expect(new VoiceLeases(dir).list()).toEqual([room]);
  expect(statSync(path.join(dir, "voice-rooms.json")).mode & 0o777).toBe(0o600);
  expect(readFileSync(path.join(dir, "voice-rooms.json"), "utf8")).toBe(JSON.stringify([room]));
  leases.remove(room); expect(new VoiceLeases(dir).list()).toEqual([]);
});
it("does not recover unrelated provider room names and fails safely for malformed recovery data", () => {
  const dir = home(); writeFileSync(path.join(dir, "voice-rooms.json"), JSON.stringify(["someone-elses-call", room]));
  expect(new VoiceLeases(dir).list()).toEqual([room]);
  writeFileSync(path.join(dir, "voice-rooms.json"), "broken JSON");
  expect(() => new VoiceLeases(dir)).toThrow("Saved voice recovery data");
});
