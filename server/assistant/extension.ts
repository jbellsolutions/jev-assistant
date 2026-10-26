import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
/** The installed extension lives at one stable private path. Pairing tokens never ship in the app. */
export function prepareExtension(root: string, env: NodeJS.ProcessEnv): string {
  const source = path.join(root, "dist", "extension");
  const target = path.join(env.JEV_HOME!, "extension");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (existsSync(source)) for (const name of readdirSync(source)) if (/^(?:background\.js|content\.js|options\.js|options\.html|manifest\.json)$/.test(name)) copyFileSync(path.join(source, name), path.join(target, name));
  writeFileSync(path.join(target, "config.json"), JSON.stringify({ url: `ws://127.0.0.1:${env.JEV_BRIDGE_PORT || env.JEV_APP_PORT || "3111"}/ws/bridge`, token: env.JEV_TOKEN }, null, 2) + "\n", { mode: 0o600 });
  return target;
}
