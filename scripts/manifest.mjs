#!/usr/bin/env node
/** Print Jev's capability manifest, or write it to a file.
 *
 *   node --import tsx scripts/manifest.mjs            # human-readable, what the Surveyor sees
 *   node --import tsx scripts/manifest.mjs --json     # the raw manifest
 *   node --import tsx scripts/manifest.mjs --out review/capabilities.json
 *   node --import tsx scripts/manifest.mjs --no-live  # skip the running-companion probe
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildManifest, describeManifest } from "../server/review/manifest.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const manifest = await buildManifest(flag("--no-live") ? { baseUrl: null } : {});
const out = value("--out");

if (out) {
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(path.resolve(out), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${out}`);
} else if (flag("--json")) {
  console.log(JSON.stringify(manifest, null, 2));
} else {
  console.log(describeManifest(manifest));
}
