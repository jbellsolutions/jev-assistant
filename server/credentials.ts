import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONNECTION_FIELDS, type ConnectionSettings } from "../core/connections.js";
import { parseEnv } from "./env.js";

function read(home: string) { try { return readFileSync(path.join(home, ".env"), "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return ""; throw new Error("Could not read private settings"); } }
export function connectionSettings(home: string): ConnectionSettings {
  const env = parseEnv(read(home));
  return Object.fromEntries(CONNECTION_FIELDS.map((f) => [f.key, { configured: !!env[f.key]?.trim(), ...(!f.secret ? { value: env[f.key] || "" } : {}) }]));
}
export function saveConnections(home: string, input: unknown): ConnectionSettings {
  if (!input || typeof input !== "object") throw new Error("Invalid connection settings");
  const { values, remove } = input as { values?: unknown; remove?: unknown };
  if (!values || typeof values !== "object" || Array.isArray(values) || !Array.isArray(remove)) throw new Error("Invalid connection settings");
  const allowed = new Set<string>(CONNECTION_FIELDS.map((f) => f.key));
  const updates = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key) || typeof value !== "string" || /[\r\n\0"'\\]/.test(value) || value.length > 4096) throw new Error("One of the connection fields is invalid");
    // Empty inputs preserve existing credentials; Remove is always explicit.
    if (value.trim()) updates.set(key, value.trim());
  }
  for (const key of remove) { if (typeof key !== "string" || !allowed.has(key)) throw new Error("Unknown connection field"); updates.set(key, ""); }
  const url = updates.get("LIVEKIT_URL");
  if (url && !/^wss:\/\/[^\s]+$/.test(url)) throw new Error("LiveKit project URL must start with wss://");
  const id = updates.get("JEV_COFOUNDER_COMPUTER");
  if (id && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error("Choose a valid Orgo computer ID");
  if (updates.get("COMPOSIO_API_KEY")?.startsWith("uak_")) throw new Error("Use a Composio project API key, rather than the CLI login key");
  let text = read(home);
  for (const [key, value] of updates) {
    const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, "gm");
    // Remove duplicates and append exactly one value; preserve unrelated settings and pairing.
    text = text.replace(pattern, "").trimEnd() + `\n${key}="${value}"\n`;
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, ".env"); const temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, text, { mode: 0o600, flag: "wx" }); renameSync(temporary, file); chmodSync(file, 0o600); }
  catch { throw new Error("Could not save private settings"); }
  finally { rmSync(temporary, { force: true }); }
  return connectionSettings(home);
}
