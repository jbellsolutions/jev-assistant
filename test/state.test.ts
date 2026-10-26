import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readState, writeState } from "../server/state.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fresh = () => {
  const d = mkdtempSync(path.join(tmpdir(), "jev-state-"));
  dirs.push(d);
  return path.join(d, "nested", "state.json");
};

describe("state file", () => {
  it("is empty when missing or corrupt", () => {
    const file = fresh();
    expect(readState(file)).toEqual({});
  });

  it("round-trips, merges patches, and is private to the user", () => {
    const file = fresh();
    expect(writeState({ listenMode: "push" }, file)).toEqual({ listenMode: "push" });
    expect(readState(file)).toEqual({ listenMode: "push" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ listenMode: "push" });
    writeState({ listenMode: "wake" }, file);
    expect(readState(file).listenMode).toBe("wake");
  });

  it("shrugs at garbage", () => {
    const file = fresh();
    writeState({}, file);
    writeFileSync(file, "{not json");
    expect(readState(file)).toEqual({});
    writeFileSync(file, "[1,2]");
    expect(readState(file)).toEqual({});
  });
});

describe("how Jev listens", () => {
  it("remembers the choice across a relaunch", () => {
    // Deliberately server-side: there is no localStorage anywhere in client/src, and a panel that
    // reconnects should find the switch where the user left it rather than back on the button.
    const file = fresh();
    expect(readState(file).listenMode).toBeUndefined();
    writeState({ listenMode: "wake" }, file);
    expect(readState(file).listenMode).toBe("wake");
  });
});
