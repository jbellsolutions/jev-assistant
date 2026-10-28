/** Opt-in owner-machine check. Opens a disposable TextEdit document and Slack; never sends a message. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";
import { parseEnv } from "../server/env.ts";
import { cliDriver, selectMac } from "../server/executors/mac.ts";
import { MacComputer } from "../server/computer.ts";
import { PhoneAccess } from "../server/phone.ts";
import { createAssistantRuntime } from "../server/assistant/runtime.ts";
if (process.env.JEV_LIVE_MAC_SMOKE !== "1") throw new Error("Set JEV_LIVE_MAC_SMOKE=1 to explicitly run this check on your Mac with your OpenAI account.");
const root = fileURLToPath(new URL("..", import.meta.url));
const saved = parseEnv(readFileSync(path.join(homedir(), ".jev-assistant", ".env"), "utf8"));
if (!saved.OPENAI_API_KEY) throw new Error("OpenAI is not configured");
const home = mkdtempSync(path.join(tmpdir(), "jarvis-phone-mac-live-"));
const manualFile = path.join(home, `Jarvis-phone-proof-${randomUUID().slice(0, 8)}.txt`), challengeFile = path.join(home, "read-proof.txt");
const manualProof = `Synthetic phone input ${randomUUID()}`, readProof = randomUUID();
writeFileSync(manualFile, "Disposable Jarvis phone control test.\n"); writeFileSync(challengeFile, readProof);
const driver = cliDriver(); const mac = selectMac(); if (!mac) throw new Error("Mac driver unavailable"); await mac.start(); assert.ok(mac.ready, "Mac Accessibility permission is required");
let selectedWindow = null, fixtureWindow = null, tls, browser, phone, runtime;
const wait = async (fn, timeout = 20000) => { const end = Date.now() + timeout; for (;;) { if (await fn()) return; if (Date.now() >= end) throw new Error("Live Mac proof timed out"); await new Promise((r) => setTimeout(r, 400)); } };
try {
  execFileSync("open", ["-a", "TextEdit", manualFile]);
  await wait(async () => { fixtureWindow = (await driver("list_windows", {})).windows?.find((w) => w.app_name === "TextEdit" && w.title.includes(path.basename(manualFile, ".txt"))); return !!fixtureWindow; }); selectedWindow = fixtureWindow;
  const env = { JEV_HOME: home, OPENAI_API_KEY: saved.OPENAI_API_KEY, JEV_BRAIN_MODEL: "gpt-6-luna" };
  runtime = createAssistantRuntime({ env, hands: { mac, chrome: null, computer: new MacComputer() }, chromeReady: () => false, computerReady: () => mac.ready,
    phoneScreen: () => selectMac({ manualDelivery: "foreground", pictureWindow: () => selectedWindow }),
  });
  phone = new PhoneAccess({ home, clientDir: path.join(root, "dist/client"), assistant: runtime }); await phone.listen(0);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${home}/tls.key`, "-out", `${home}/tls.crt`, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  tls = https.createServer({ key: readFileSync(`${home}/tls.key`), cert: readFileSync(`${home}/tls.crt`) }, (req, res) => { const u = http.request({ host: "127.0.0.1", port: phone.status().port, path: req.url, method: req.method, headers: { ...req.headers, "x-forwarded-proto": "https" } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); u.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(u); });
  await new Promise((r) => tls.listen(0, "127.0.0.1", r)); const origin = `https://localhost:${tls.address().port}`; await phone.configure(origin);
  browser = await chromium.launch(); const { defaultBrowserType: _, ...device } = devices["iPhone 13"]; const context = await browser.newContext({ ...device, ignoreHTTPSErrors: true }); const page = await context.newPage();
  await page.goto(`${origin}/phone`); await page.getByLabel("Pairing code").fill(phone.issueCode().code); await page.getByRole("button", { name: "Connect to Jarvis", exact: true }).click(); await page.locator(".phone-connection.connected").waitFor();
  const call = (route, body) => page.evaluate(async ({ route, body }) => { const r = await fetch(`/assistant${route}`, { method: body === undefined ? "GET" : "POST", headers: { "X-Jev-UI": "1", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await r.json(); if (!r.ok) throw Error(data.error || "Phone request failed"); return data; }, { route, body });
  let frame = await call("/mac/screen"); assert.ok(frame.jpegBase64.length > 1000); assert.ok(frame.title.includes(path.basename(manualFile, ".txt")));
  await call("/mac/input", { requestId: randomUUID(), frameId: frame.frameId, action: "click", fx: .5, fy: .35 });
  frame = await call("/mac/screen");
  await call("/mac/input", { requestId: randomUUID(), frameId: frame.frameId, action: "key", key: "cmd+a" });
  frame = await call("/mac/screen"); await call("/mac/input", { requestId: randomUUID(), frameId: frame.frameId, action: "text", text: manualProof });
  await wait(async () => { const observed = await driver("get_window_state", { pid: fixtureWindow.pid, window_id: fixtureWindow.window_id, include_screenshot: false, max_elements: 900, max_depth: 24 }); return JSON.stringify(observed).includes(manualProof); });
  console.log("PASS: paired phone HTTPS capture and input reached the actual disposable TextEdit window; nonce independently verified from Mac accessibility.");
  await call("/command", { text: `On this Mac, open Slack using mac_act open_app. Read Slack using mac_read with screen:true. Then use the read-only shell tool to cat this exact file: ${challengeFile}. Report that file's exact synthetic proof string and whether the Mac screenshot was returned. Do not send, type, click messages, change settings or act in any Slack channel. This is an owner-authorized connection test.`, target: "local", requestId: randomUUID() });
  let task; await wait(async () => { task = runtime.queue.list()[0]; if (task?.approval) { await runtime.queue.approve(task.id, "deny", task.approval.requestId); throw new Error("Unexpected write approval in a read-only connection test"); } return task && ["completed", "failed", "paused"].includes(task.status); }, 180000);
  assert.equal(task.status, "completed", "Live local worker must complete");
  assert.ok(task.output.includes(readProof), "Luna must independently read the disposable file");
  assert.ok(task.history.some((h) => h.text.includes("Using mac_act"))); assert.ok(task.history.some((h) => h.text.includes("Using mac_read"))); assert.ok(task.history.some((h) => h.text.includes("Using shell")));
  selectedWindow = mac.window; frame = await call("/mac/screen"); assert.ok(selectedWindow?.app_name === "Slack"); assert.ok(frame.jpegBase64.length > 1000);
  console.log("PASS: a phone request ran the real Luna Mac worker, opened/inspected Slack with a screenshot and read an independently generated local-file proof. No message was sent.");
} finally {
  await browser?.close(); if (tls) await new Promise((r) => tls.close(r)); await phone?.close(); await runtime?.close();
  if (fixtureWindow) { await driver("press_key", { pid: fixtureWindow.pid, window_id: fixtureWindow.window_id, key: "s", modifiers: ["cmd"], delivery_mode: "foreground" }).catch(() => {}); await new Promise((r) => setTimeout(r, 500)); await driver("invoke_menu", { pid: fixtureWindow.pid, window_id: fixtureWindow.window_id, path: ["File", "Close"] }).catch(() => {}); }
  rmSync(home, { recursive: true, force: true });
}
