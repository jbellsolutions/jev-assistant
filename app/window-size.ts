import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
export function windowSize(home: string, area: { width: number; height: number }) {
  let size = { width: 1080, height: 800 };
  try { const s = JSON.parse(readFileSync(path.join(home, "window.json"), "utf8")); if (Number.isFinite(s.width) && Number.isFinite(s.height)) size = s; } catch {}
  return { width: Math.round(Math.min(Math.max(size.width, 360), area.width - 32)), height: Math.round(Math.min(Math.max(size.height, 480), area.height - 32)) };
}
export function saveWindowSize(home: string, size: { width: number; height: number }) {
  mkdirSync(home, { recursive: true, mode: 0o700 }); const file = path.join(home, "window.json");
  writeFileSync(`${file}.tmp`, JSON.stringify(size), { mode: 0o600 }); renameSync(`${file}.tmp`, file);
}
