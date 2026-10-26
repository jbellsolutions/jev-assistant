import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadEnvFile, parseEnv } from "./env.js";
import { CONNECTION_FIELDS } from "../core/connections.js";

/** One private config/state home for source and installed builds; never bundle .env. */
export function loadConfiguration(root: string, env: NodeJS.ProcessEnv = process.env): void {
  env.JEV_HOME ||= path.join(homedir(), ".jev-assistant");
  loadEnvFile(path.join(root, ".env"), env);
  mkdirSync(env.JEV_HOME, { recursive: true, mode: 0o700 });
  const file = path.join(env.JEV_HOME, ".env");
  loadEnvFile(file, env);
  // Saved connection changes win over values inherited by Electron during relaunch.
  if (existsSync(file)) {
    const saved = parseEnv(readFileSync(file, "utf8"));
    for (const { key } of CONNECTION_FIELDS) if (key in saved) env[key] = saved[key];
  }
  if (!env.JEV_TOKEN?.trim()) {
    env.JEV_TOKEN = randomBytes(32).toString("hex");
    if (!existsSync(file)) writeFileSync(file, `# Private Jev Assistant configuration\nJEV_TOKEN=${env.JEV_TOKEN}\n`, { mode: 0o600 });
    else throw new Error("Set a nonempty JEV_TOKEN in the private Jev configuration before starting.");
  }
  if (existsSync(file)) chmodSync(file, 0o600);
  env.JEV_APP_PORT ||= "3111";
  env.JEV_BRIDGE_PORT ||= env.JEV_APP_PORT;
  env.JEV_LEAD_MODEL ||= "off";
  env.JEV_TTS ||= "off";
  env.JEV_BRAIN_MODEL ||= "gpt-6-luna";
  // This desktop uses one continuous LiveKit conversation, with no legacy STT fallback.
  env.STT_PROVIDER = "off";
}
