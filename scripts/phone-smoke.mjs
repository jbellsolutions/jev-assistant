/** Synthetic phone UI through a real HTTPS reverse proxy; no provider accounts or user data. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";
import { createAssistantRuntime } from "../server/assistant/runtime.ts";
import { createCompanion } from "../server/companion.ts";
import { HeuristicDecider } from "../core/decide.ts";
const root = fileURLToPath(new URL("..", import.meta.url));
const home = mkdtempSync(path.join(tmpdir(), "jarvis-phone-smoke-"));
const screenshots = path.join(root, "scratch", "phone-preview"); mkdirSync(screenshots, { recursive: true });
const completions = new Map(); const executed = [];
const worker = {
  run(task, ctx) {
    executed.push(task.target);
    if (!task.goal.startsWith("Approval fixture")) return Promise.resolve(`Synthetic ${task.target} result`);
    return new Promise((resolve, reject) => {
      completions.set(task.id, resolve);
      ctx.signal.addEventListener("abort", () => reject(new Error("Stopped fixture")), { once: true });
      ctx.event({ kind: "approval", requestId: `approval-${task.id}`, summary: "perform this synthetic test action", choices: ["once", "deny"] });
    });
  },
  async approve(id, choice) { completions.get(id)?.(`Synthetic approval: ${choice}`); },
};
const assistant = createAssistantRuntime({ env: { JEV_HOME: home }, hands: { mac: null, chrome: null, computer: null }, chromeReady: () => false, computerReady: () => false, workers: { local: worker, cloud: worker } });
const companion = createCompanion({ assistant, token: "synthetic-phone-smoke-token", decider: new HeuristicDecider(), clientDir: path.join(root, "dist/client"), phone: { home, port: 0 } });
let tls; let browser;
try {
  const port = await companion.listen(0);
  const headers = { authorization: "Bearer synthetic-phone-smoke-token", "Content-Type": "application/json" };
  const desktop = async (route, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/phone-access${route}`, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); assert.equal(r.status, 200); return r.json();
  };
  const gateway = (await desktop("/status")).port;
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${home}/tls.key`, "-out", `${home}/tls.crt`, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  tls = https.createServer({ key: readFileSync(`${home}/tls.key`), cert: readFileSync(`${home}/tls.crt`) }, (req, res) => {
    const upstream = http.request({ host: "127.0.0.1", port: gateway, path: req.url, method: req.method, headers: { ...req.headers, "x-forwarded-proto": "https" } }, (response) => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  await new Promise((resolve) => tls.listen(0, "127.0.0.1", resolve));
  const origin = `https://localhost:${tls.address().port}`; await desktop("/configure", { origin });
  for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
    browser = await engine.launch();
    const { defaultBrowserType: _, ...device } = devices["iPhone 13"];
    const context = await browser.newContext({ ...device, ignoreHTTPSErrors: true });
    const page = await context.newPage(); const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", async (r) => { if (r.status() >= 400) console.log(`Fixture HTTP ${r.status()}: ${new URL(r.url()).pathname} ${(await r.text()).slice(0, 250)}`); });
    await page.goto(`${origin}/phone`);
    await page.getByRole("heading", { name: "Connect to your Mac" }).waitFor();
    await page.screenshot({ path: `${screenshots}/${name}-pairing.png`, fullPage: true });
    const pairing = await desktop("/pairing", {});
    await page.getByLabel("Pairing code").fill(pairing.code);
    await page.getByRole("button", { name: "Connect to Jarvis", exact: true }).click();
    try { await page.locator(".phone-connection.connected").waitFor(); }
    catch (e) { console.log((await page.locator("body").innerText()).slice(0, 2000)); await page.screenshot({ path: `${screenshots}/${name}-failure.png`, fullPage: true }); throw e; }
    assert.ok((await context.cookies()).some((c) => c.name === "__Host-jarvis-phone" && c.httpOnly && c.secure));
    await page.screenshot({ path: `${screenshots}/${name}-talk.png`, fullPage: true });
    for (const target of ["cloud", "local"]) {
      await page.getByLabel("Work environment").selectOption(target);
      await page.getByLabel("Or give me a task").fill(`Synthetic ${name} ${target} task`);
      await page.getByRole("button", { name: "Give Jarvis this task" }).click();
      await page.waitForFunction(() => document.querySelector("#phone-task")?.value === "");
    }
    await page.getByLabel("Or give me a task").fill(`Approval fixture ${name}`);
    await page.getByRole("button", { name: "Give Jarvis this task" }).click();
    await page.getByRole("button", { name: /^Tasks/ }).click();
    await page.getByRole("button", { name: "Allow once", exact: true }).waitFor();
    await page.screenshot({ path: `${screenshots}/${name}-tasks.png`, fullPage: true });
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await page.getByText("Synthetic approval: once", { exact: true }).waitFor({ state: "attached" });
    const maxScroll = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert.ok(maxScroll <= 1, `Horizontal overflow: ${maxScroll}`);
    await page.reload(); await page.locator(".phone-connection.connected").waitFor();
    // Voice errors remain honest when this fixture has no provider credentials.
    await page.getByRole("button", { name: "Talk to Jarvis", exact: true }).click();
    await page.getByText(/Add your OpenAI and LiveKit credentials/).waitFor();
    await page.getByRole("button", { name: "Browser", exact: true }).click();
    await page.getByRole("button", { name: "Open browser", exact: true }).waitFor();
    await page.getByRole("button", { name: "Open browser", exact: true }).click();
    await page.getByText("Add Browser Use in Connection settings first", { exact: true }).waitFor();
    // Revoking on the Mac logs the phone out on its next refresh.
    const d = (await desktop("/status")).devices.at(-1); await desktop("/revoke", { id: d.id });
    await page.getByRole("heading", { name: "Connect to your Mac" }).waitFor();
    assert.deepEqual(errors, []);
    await browser.close(); browser = null;
    console.log(`PASS: ${name} iPhone viewport: HTTPS pairing, shared cloud/Mac tasks, approval, reload, browser/voice configuration errors, revocation and layout.`);
  }
  assert.equal(executed.filter((s) => s === "cloud").length, 2); assert.equal(executed.filter((s) => s === "local").length, 4);
} finally {
  await browser?.close();
  if (tls) await new Promise((resolve) => tls.close(resolve));
  await companion.close(); rmSync(home, { recursive: true, force: true });
}
