/** Live check for "everything speaks" — and, more importantly, for everything that must NOT.
 *
 *  Runs a real companion with a recording voice and drives it through each door in turn: the panel
 *  socket (a human), POST /api/command (a script, or the Monday review), and MCP-shaped local calls.
 *  Asserts what was said, not what was displayed.
 *
 *  A Fish key is not needed: the failure this guards against is a lane that speaks to an empty room,
 *  and the text handed to the speaker is exactly where that shows up.
 *
 *    node --import tsx scripts/speak-smoke.mjs
 */
import path from "node:path";
import WebSocket from "ws";
import { createCompanion } from "../server/companion.js";
import { HeuristicDecider } from "../core/decide.js";
import { loadEnvFile } from "../server/env.js";
import { SpeechGate } from "../server/speak/gate.js";

loadEnvFile(path.join(import.meta.dirname, "..", ".env"));

const spoken = [];
const speaker = { speak: async (t) => void spoken.push(t), stop: () => {}, maxChars: 600 };
const gate = new SpeechGate();

// A surface that needs no browser: every lane below decides and reports without leaving the machine.
const executor = {
  id: "fake",
  kind: "playwright",
  capabilities: { click: true, type: true, navigate: true, read: false, screenshot: false },
  viewport: { width: 1200, height: 800 },
  async snapshot() {
    return { url: "https://example.com", title: "Example", elements: [] };
  },
  async execute() {
    return "did it";
  },
  async title() {
    return "Example";
  },
  onChange() {
    return () => {};
  },
  async close() {},
};

const companion = createCompanion({ decider: new HeuristicDecider(), speaker, gate });
companion.hub.register(executor); // executors are registered, not passed in
const port = await companion.listen(0);
const base = `http://127.0.0.1:${port}`;
const token = process.env.JEV_TOKEN;

const clear = () => spoken.splice(0);
const check = (what, expectSpoken) => {
  const said = spoken.length > 0;
  const ok = said === expectSpoken;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what.padEnd(46)} ${said ? JSON.stringify(spoken.join(" ").slice(0, 60)) : "(silent)"}`);
  clear();
  return ok;
};

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
ws.on("close", (code, reason) => { if (code !== 1000 && code !== 1005) console.log(`  panel socket closed: ${code} ${reason}`); });
const seen = [];
ws.on("message", (d) => seen.push(JSON.parse(String(d))));
if (process.env.VERBOSE) setInterval(() => { for (const m of seen.splice(0)) if (m.type === "status" || m.type === "error") console.log("     <-", JSON.stringify(m)); }, 200).unref?.();
await new Promise((r) => ws.once("open", r));
const settle = () => new Promise((r) => setTimeout(r, 400));

let pass = true;
console.log("who gets a voice:\n");

// The panel: a human typed it. This one speaks.
ws.send(JSON.stringify({ type: "command", text: "set a timer for 10 minutes" }));
await settle();
pass = check("the panel socket (a human, at the panel)", true) && pass;

// A script, curl, or the 09:00 Monday review. Silence, or it talks to an empty kitchen.
await fetch(`${base}/api/command`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ text: "set a timer for 5 minutes" }),
});
await settle();
pass = check("POST /api/command (a script, or a cron job)", false) && pass;

// /api/ask is what Hermes reaches through MCP while the user is on Telegram, in another building.
await fetch(`${base}/api/ask`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ text: "how long is left" }),
});
await settle();
pass = check("POST /api/ask (Hermes, from Telegram)", false) && pass;

// And the panel again, to prove the silence above was the caller and not a broken voice.
ws.send(JSON.stringify({ type: "command", text: "how long is left" }));
await settle();
pass = check("the panel socket again (still speaking)", true) && pass;

ws.close();
await companion.close();
console.log(`\n${pass ? "all lanes speak to the right room" : "SOMETHING SPOKE TO THE WRONG ROOM"}`);
process.exit(pass ? 0 : 1);
