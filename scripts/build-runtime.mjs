/** Bundle the real Node executable for LiveKit. Electron's Node mode also loads Chromium's
 * WebRTC Objective-C classes and conflicts with rtc-node on macOS. */
import { chmodSync, copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
if (process.versions.electron) throw new Error("Build the voice runtime using Node, not Electron");
const dir = fileURLToPath(new URL("../build/runtime/", import.meta.url));
mkdirSync(dir, { recursive: true });
copyFileSync(realpathSync(process.execPath), `${dir}node`);
chmodSync(`${dir}node`, 0o755);
