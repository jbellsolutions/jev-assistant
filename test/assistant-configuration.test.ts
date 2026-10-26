import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfiguration } from "../server/configuration.js";
import { prepareExtension } from "../server/assistant/extension.js";
import { selectOrgo } from "../server/orgo.js";
import { selectCofounder } from "../server/cofounder.js";
describe("private installed configuration", () => {
  it("never assigns a new install to the developer's Orgo computer", () => {
    expect(selectOrgo({ ORGO_API_KEY: "fake-key" })).toBeNull();
    expect(selectCofounder({ ORGO_API_KEY: "fake-key" })).toBeNull();
    expect(selectOrgo({ ORGO_API_KEY: "fake-key", JEV_COFOUNDER_COMPUTER: "00000000-0000-4000-8000-000000000000" })?.computerId).toBe("00000000-0000-4000-8000-000000000000");
  });
  it("generates one stable private token and pairs the extension outside the application", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jev-config-test-"));
    try {
      const root = path.join(dir, "app"); const home = path.join(dir, "private");
      mkdirSync(path.join(root, "dist", "extension"), { recursive: true }); writeFileSync(path.join(root, "dist", "extension", "manifest.json"), "{}");
      const env: NodeJS.ProcessEnv = { JEV_HOME: home }; loadConfiguration(root, env);
      expect(env.JEV_TOKEN).toHaveLength(64); expect(env.JEV_LEAD_MODEL).toBe("off"); expect(env.JEV_TTS).toBe("off");
      const again: NodeJS.ProcessEnv = { JEV_HOME: home }; loadConfiguration(root, again); expect(again.JEV_TOKEN).toBe(env.JEV_TOKEN);
      const out = prepareExtension(root, env); const cfg = JSON.parse(readFileSync(path.join(out, "config.json"), "utf8"));
      expect(out.startsWith(home)).toBe(true); expect(cfg).toMatchObject({ token: env.JEV_TOKEN, url: "ws://127.0.0.1:3111/ws/bridge" });
      expect(statSync(path.join(out, "config.json")).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(home, ".env")).mode & 0o777).toBe(0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
