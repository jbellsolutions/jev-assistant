/** Writes build/icon.png — a placeholder app icon (see app/tray-icon.ts's appIconPng).
 *  electron-builder converts a single >=512x512 PNG to .icns for the mac target automatically.
 *  Usage: node --import tsx scripts/build-icon.mjs */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appIconPng } from "../app/tray-icon.ts";

const out = fileURLToPath(new URL("../build/icon.png", import.meta.url));
mkdirSync(new URL("../build/", import.meta.url), { recursive: true });
writeFileSync(out, appIconPng(1024));
console.log(`wrote ${out}`);
