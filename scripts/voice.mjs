#!/usr/bin/env node
/** Hear Jev's voice without launching the app.
 *
 *   node --import tsx scripts/voice.mjs "Muted."          # say one line (and cache it)
 *   node --import tsx scripts/voice.mjs --warm            # pre-render the whole scripted table
 *   node --import tsx scripts/voice.mjs --cache           # what is already on disk
 *
 * This is the live check for M1: say the same line twice and the second one makes no network call.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { loadEnvFile } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  loadEnvFile(path.join(root, ".env"));
} catch {
  /* no .env is fine; the selector will say the voice is off */
}

const { warmableLines } = await import("../core/lines.ts");
const { defaultCacheDir } = await import("../server/speak/fish.ts");
const { selectSpeaker, describeSpeaker } = await import("../server/speak/select.ts");
const { warmVoice, describeWarm } = await import("../server/speak/warm.ts");

const args = process.argv.slice(2);
const cacheDir = defaultCacheDir();

if (args.includes("--cache")) {
  const files = existsSync(cacheDir) ? readdirSync(cacheDir).filter((f) => f.endsWith(".mp3")) : [];
  const bytes = files.reduce((n, f) => n + statSync(path.join(cacheDir, f)).size, 0);
  console.log(`${cacheDir}: ${files.length} lines, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`scripted vocabulary: ${warmableLines().length} lines`);
  process.exit(0);
}

const speaker = selectSpeaker();
console.log(describeSpeaker(speaker));
if (!speaker) {
  console.log("Set FISH_AUDIO_API_KEY in .env to hear anything. Everything else in Jev works without it.");
  process.exit(1);
}

if (args.includes("--warm")) {
  console.log(`rendering ${warmableLines().length} lines…`);
  console.log(describeWarm(await warmVoice(speaker)));
  process.exit(0);
}

const text = args.join(" ").trim() || "Hey the user. This is my voice now.";
const cached = speaker.isCached(text);
const started = Date.now();
await speaker.speak(text);
console.log(`${cached ? "played from cache" : "synthesized and cached"} in ${Date.now() - started}ms: ${JSON.stringify(text)}`);
