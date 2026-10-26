// Live check of the brain against the REAL model, with FAKE hands: nothing on this Mac is touched.
//   node --import tsx scripts/brain-smoke.mjs "what does the pro plan cost?"
// Proves the model calls the named tools through the AI SDK loop, asks before a write, and answers.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentBrain } from "../server/brain/agent.ts";
import { fileRunLog } from "../server/brain/runlog.ts";
import { ChatStore } from "../server/brain/chat-store.ts";
import { selectBrowserBox } from "../server/browserbox.ts";
import { FakeExecutor, el } from "../test/helpers/fake-executor.ts";

try { process.loadEnvFile(".env"); } catch {}
const question = process.argv[2] ?? "In my Chrome, what does the Pro plan cost? Then send Xander that price in the message box.";
const chrome = new FakeExecutor([el("e0", { tag: "textarea", label: "Message Xander" }), el("e1", { tag: "button", label: "Send" }), el("e2", { tag: "a", label: "Pricing" })], "chrome");
chrome.pageText = "Acme pricing. The Pro plan costs $42 per month. The Team plan costs $99 per month.";
const dir = mkdtempSync(path.join(tmpdir(), "jev-brain-smoke-"));
const brain = createAgentBrain(process.env, { hands: { chrome, mac: null, computer: null, box: selectBrowserBox(process.env) }, log: fileRunLog(dir), chat: new ChatStore(null) }); // never the user's own chat
if (!brain) throw new Error("OPENROUTER_API_KEY is not set");
console.log(`model: ${brain.modelId}\nquestion: ${question}\n`);
const t0 = Date.now();
const run = await brain.send(question);
for await (const e of run.events) {
  if (e.kind === "approval") {
    console.log(`  ? ${e.summary} → answering yes`);
    void brain.approve(run.id, "once", e.requestId);
  } else if (e.kind === "tool_start") console.log(`  → ${e.tool} ${e.preview}`);
  else if (e.kind === "completed") console.log(`\nanswer (${Date.now() - t0}ms): ${e.output}`);
  else if (e.kind === "failed") console.log(`\nFAILED: ${e.error}`);
}
console.log(`\nchrome actions: ${JSON.stringify(chrome.executed)}`);
const day = readdirSync(dir)[0];
const file = path.join(dir, day, readdirSync(path.join(dir, day))[0]);
console.log(`run log: ${file}`);
console.log(readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).type).join(" → "));
