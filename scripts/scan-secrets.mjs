import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
const files = [...new Set(execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter(Boolean))];
const rules = [
  ["OpenAI key", /sk-proj-[A-Za-z0-9_-]{35,}/], ["Orgo key", /sk_live_[A-Za-z0-9]{24,}/],
  ["TypeSafe key", /apikey_[A-Za-z0-9_]{30,}/], ["Browser Use key", /bu_[A-Za-z0-9_-]{25,}/],
  ["GitHub token", /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{35,})/],
  ["OpenRouter key", /sk-or-v1-[A-Za-z0-9]{35,}/],
  ["Salesforce consumer key", /3MVG[A-Za-z0-9_.]{35,}/],
  ["literal credential", /\b(?:key|secret|apiKey|clientSecret|consumerKey|consumerSecret)\s*[:=]\s*["'][a-fA-F0-9]{48,}["']/i],
];
const privateFile = path.join(process.env.JEV_HOME || path.join(homedir(), ".jev-assistant"), ".env");
const exact = existsSync(privateFile) ? readFileSync(privateFile, "utf8").split(/\r?\n/).flatMap((s) => {
  const m = /^(\w*(?:KEY|SECRET|TOKEN))=(.*)$/.exec(s.trim()); if (!m) return [];
  const value = m[2].replace(/^["']|["']$/g, "").trim(); return value.length >= 16 ? [value] : [];
}) : [];
let failures = 0;
for (const file of files) {
  if (!existsSync(file)) continue;
  const content = readFileSync(file); const text = content.toString("utf8");
  for (const [label, pattern] of rules) if (pattern.test(text)) { console.error(`${file}: possible ${label}`); failures++; }
  if (exact.some((secret) => content.includes(Buffer.from(secret)))) { console.error(`${file}: contains a value from private settings`); failures++; }
}
if (failures) { console.error(`Secret scan failed (${failures} findings); no secret values were printed.`); process.exitCode = 1; }
else console.log(`PASS: ${files.length} repository files scanned; no credential findings.`);
