import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectionSettings, saveConnections } from "../server/credentials.js";
import { loadConfiguration } from "../server/configuration.js";
import { parseEnv } from "../server/env.js";
const dirs: string[] = [];
function setup() { const home = mkdtempSync(path.join(tmpdir(), "jev-credentials-")); dirs.push(home); const file = path.join(home, ".env"); writeFileSync(file, "# Private settings\nJEV_TOKEN=stable-pairing\nOPENAI_API_KEY=old-secret\nJEV_APP_PORT=3111\n"); return { home, file }; }
afterEach(() => dirs.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
describe("desktop connection editing", () => {
  it("replaces keys privately, preserves empty fields and never returns saved secrets", () => {
    const { home, file } = setup();
    const s = saveConnections(home, { values: { OPENAI_API_KEY: "", ORGO_API_KEY: "new-secret", LIVEKIT_URL: "wss://jev.livekit.cloud" }, remove: [] });
    expect(s.ORGO_API_KEY).toEqual({ configured: true }); expect(s.LIVEKIT_URL?.value).toBe("wss://jev.livekit.cloud");
    expect(JSON.stringify(s)).not.toMatch(/new-secret|old-secret/);
    expect(parseEnv(readFileSync(file, "utf8"))).toMatchObject({ OPENAI_API_KEY: "old-secret", ORGO_API_KEY: "new-secret", JEV_TOKEN: "stable-pairing", JEV_APP_PORT: "3111" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it("removes keys explicitly and reloads saved values over inherited relaunch values", () => {
    const { home } = setup(); saveConnections(home, { values: { OPENAI_API_KEY: "replacement" }, remove: [] });
    const env = { JEV_HOME: home, OPENAI_API_KEY: "inherited-old" }; loadConfiguration(home, env); expect(env.OPENAI_API_KEY).toBe("replacement");
    saveConnections(home, { values: {}, remove: ["OPENAI_API_KEY"] }); loadConfiguration(home, env); expect(env.OPENAI_API_KEY).toBe(""); expect(connectionSettings(home).OPENAI_API_KEY?.configured).toBe(false);
  });
  it("rejects field injection, internal settings and invalid values without modifying the file", () => {
    const { home, file } = setup(); const before = readFileSync(file, "utf8");
    for (const values of [{ JEV_TOKEN: "replace" }, { ORGO_API_KEY: "key\nJEV_TOKEN=replace" }, { LIVEKIT_URL: "http://bad" }, { COMPOSIO_API_KEY: "uak_cli" }, { JEV_COFOUNDER_COMPUTER: "wrong" }]) expect(() => saveConnections(home, { values, remove: [] })).toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
