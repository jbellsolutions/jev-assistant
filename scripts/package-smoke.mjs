/** Relocate the entire .app outside the repository to catch hidden dependency fallbacks. */
import assert from "node:assert/strict";
import { constants, cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const root = fileURLToPath(new URL("..", import.meta.url));
const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "jev-package-check-")));
try {
  const app = path.join(dir, "Jarvis.app");
  cpSync(path.join(root, "dist-electron", "mac-arm64", "Jarvis.app"), app, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  const resources = path.join(app, "Contents", "Resources");
  const entry = path.join(resources, "app", "dist", "voice", "agent.mjs");
  const code = `import {createRequire} from 'node:module'; const r=createRequire(${JSON.stringify(pathToFileURL(entry).href)}); const resolved=r.resolve('@livekit/rtc-node'); if(!resolved.startsWith(${JSON.stringify(dir)})) throw new Error('RTC resolved outside the relocated app'); const m=await import(${JSON.stringify(pathToFileURL(entry).href)}); if(!m.default.entry) process.exit(1); console.log('Packaged voice dependencies resolved inside the relocated app with the standalone Node runtime.');`;
  const result = spawnSync(path.join(resources, "runtime", "node"), ["--input-type=module", "-e", code], { cwd: dir, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } });
  assert.equal(result.status, 0, result.stderr); assert.ok(!/implemented in both|Cannot find/.test(result.stderr), result.stderr);
  console.log(`PASS: ${result.stdout.trim()}`);
  const smoke = spawnSync(process.execPath, [path.join(root, "scripts", "desktop-smoke.mjs")], { cwd: root, stdio: "inherit", env: { ...process.env, JEV_SMOKE_EXECUTABLE: path.join(app, "Contents", "MacOS", "Jarvis") } });
  assert.equal(smoke.status, 0, "Relocated packaged desktop smoke failed");
} finally { rmSync(dir, { recursive: true, force: true }); }
