import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneAccess } from "../server/phone.js";
import { createAssistantRuntime } from "../server/assistant/runtime.js";
import type { TaskWorker } from "../server/assistant/tasks.js";
import { createCompanion } from "../server/companion.js";
import { HeuristicDecider } from "../core/decide.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
async function boot() {
  const home = mkdtempSync(path.join(tmpdir(), "jarvis-phone-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(path.join(home, "index.html"), "<title>Jarvis phone fixture</title>");
  const calls: string[] = [];
  const worker: TaskWorker = { async run(t) { calls.push(t.target); return "Synthetic task finished"; } };
  const assistant = createAssistantRuntime({ env: { JEV_HOME: home }, hands: { mac: null, chrome: null, computer: null }, chromeReady: () => false, computerReady: () => false, workers: { local: worker, cloud: worker } });
  const phone = new PhoneAccess({ home, clientDir: home, assistant }); await phone.listen(0);
  cleanups.push(async () => { await phone.close(); await assistant.close(); });
  const origin = "https://phone.example.test:9443";
  await phone.configure(origin);
  const base = `http://127.0.0.1:${phone.status().port}`;
  const request = (route: string, body?: unknown, cookie = "", extra: Record<string, string> = {}) => new Promise<Response>((resolve, reject) => {
    // Model a tunnel's preserved Host header; Node fetch rewrites it to the loopback address.
    const req = httpRequest(`${base}${route}`, { method: body === undefined ? "GET" : "POST", headers: { host: new URL(origin).host, origin, "X-Jev-UI": "1", "Content-Type": "application/json", cookie, ...extra } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (chunk) => chunks.push(chunk)); res.on("end", () => { const headers = new Headers(); for (const [key, value] of Object.entries(res.headers)) if (value) for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v); resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers })); });
    }); req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const pair = async () => { const pairing = phone.issueCode(); const response = await request("/phone/pair", { code: pairing.code, name: "Test phone" }); expect(response.status).toBe(200); return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, response, pairing }; };
  return { home, phone, assistant, origin, base, request, pair, calls };
}
describe("phone gateway", () => {
  it("pairs once, stores only hashed cookies, and persists pairing across gateway restarts", async () => {
    const { phone, home, request, pair, assistant } = await boot();
    const { cookie, response, pairing } = await pair();
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/); expect(response.headers.get("set-cookie")).toMatch(/Secure/); expect(response.headers.get("set-cookie")).toMatch(/SameSite=Strict/);
    expect((await request("/phone/pair", { code: pairing.code })).status).toBe(401);
    expect(await (await request("/phone/session", undefined, cookie)).json()).toMatchObject({ paired: true, name: "Test phone" });
    const saved = readFileSync(path.join(home, "phone-devices.json"), "utf8");
    expect(saved).not.toContain(cookie.split("=")[1]); expect(saved).not.toContain(pairing.code); expect(statSync(path.join(home, "phone-devices.json")).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(phone.status())).not.toContain("digest");
    const restored = new PhoneAccess({ home, clientDir: home, assistant }); expect(restored.status().devices).toHaveLength(1); expect(restored.status().origin).toBe(phone.status().origin);
  });
  it("rejects unpaired calls, wrong origins, HTTP proxying and routes outside the phone surface", async () => {
    const { request, pair, phone } = await boot();
    expect((await request("/assistant/status")).status).toBe(401);
    const { cookie } = await pair();
    expect((await request("/assistant/status", undefined, cookie, { origin: "https://foreign.test" })).status).toBe(403);
    expect((await request("/assistant/status", undefined, cookie, { host: "foreign.test" })).status).toBe(403);
    expect((await request("/assistant/status", undefined, cookie, { "x-forwarded-proto": "http" })).status).toBe(403);
    expect((await request("/assistant/command", { text: "Work", target: "local" }, cookie, { "X-Jev-UI": "" })).status).toBe(403);
    for (const route of ["/voice/delegate", "/voice/state", "/voice/updates", "/permissions", "/apps/connect"]) expect((await request(`/assistant${route}`, {}, cookie)).status).toBe(403);
    for (const route of ["/api/health", "/ws", "/ws/bridge", "/attachments", "/phone-access/pairing", "/phone-devices.json"]) expect((await request(route, undefined, cookie)).status).toBe(404);
    await phone.configure(""); expect((await request("/phone/session", undefined, cookie)).status).toBe(503);
  });
  it("shares local and cloud tasks with the desktop runtime and deduplicates a retry", async () => {
    const { request, pair, assistant, calls } = await boot(); const { cookie } = await pair();
    for (const target of ["cloud", "local"]) {
      const body = { text: `Synthetic ${target} task`, target, requestId: `phone-${target}` };
      expect((await request("/assistant/command", body, cookie)).status).toBe(200);
      expect((await request("/assistant/command", body, cookie)).status).toBe(200);
    }
    await vi.waitFor(() => expect(assistant.queue.list().every((t) => t.status === "completed")).toBe(true));
    const data = await (await request("/assistant/status", undefined, cookie)).json();
    expect(data.tasks).toHaveLength(2); expect(calls).toEqual(["cloud", "local"]); expect(data.tasks.map((t: { id: string }) => t.id).sort()).toEqual(assistant.status().tasks.map((t) => t.id).sort());
  });
  it("invalidates removed/expired devices and ends the removed phone's voice", async () => {
    const { request, pair, phone, assistant } = await boot(); const { cookie } = await pair();
    const end = vi.spyOn(assistant, "endPhoneVoice"); const id = phone.status().devices[0]!.id;
    await phone.revoke(id); expect(end).toHaveBeenCalledWith(id); expect((await request("/assistant/status", undefined, cookie)).status).toBe(401);
    const other = await pair(); vi.setSystemTime(Date.now() + 31 * 86400000);
    expect((await request("/assistant/status", undefined, other.cookie)).status).toBe(401);
  });
  it("expires codes, bounds guesses, rejects invalid addresses and revokes pairing on origin changes", async () => {
    const { phone, request, pair } = await boot();
    for (const value of ["http://plain.test", "https://user:password@phone.test", "https://phone.test/path", "https://phone.test?x=1"]) await expect(phone.configure(value)).rejects.toThrow();
    let code = phone.issueCode().code;
    for (let i = 0; i < 10; i++) expect((await request("/phone/pair", { code: "invalid" })).status).toBe(401);
    expect((await request("/phone/pair", { code })).status).toBe(401);
    code = phone.issueCode().code; vi.setSystemTime(Date.now() + 6 * 60000); expect((await request("/phone/pair", { code })).status).toBe(401); vi.useRealTimers();
    await pair(); await phone.configure("https://new-phone.example.test"); expect(phone.status().devices).toHaveLength(0);
  });
  it("supports logout and keeps private responses out of caches", async () => {
    const { request, pair } = await boot(); const { cookie } = await pair();
    const status = await request("/assistant/status", undefined, cookie); expect(status.headers.get("cache-control")).toBe("no-store"); expect(status.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await request("/phone/logout", {}, cookie)).status).toBe(200); expect((await request("/assistant/status", undefined, cookie)).status).toBe(401);
  });
  it("protects pairing management with the unchanged desktop authorization boundary", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "jarvis-phone-desktop-")); cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const assistant = createAssistantRuntime({ env: { JEV_HOME: home }, hands: { mac: null, chrome: null, computer: null }, chromeReady: () => false, computerReady: () => false });
    const companion = createCompanion({ decider: new HeuristicDecider(), token: "test-companion-token", assistant, clientDir: home, phone: { home, port: 0 } });
    cleanups.push(() => companion.close()); const port = await companion.listen(0); const base = `http://127.0.0.1:${port}/phone-access`;
    expect((await fetch(`${base}/status`)).status).toBe(401);
    expect((await fetch(`${base}/status`, { headers: { "X-Jev-UI": "1", origin: "https://foreign.test" } })).status).toBe(401);
    const headers = { authorization: "Bearer test-companion-token", "Content-Type": "application/json" };
    const configured = await fetch(`${base}/configure`, { method: "POST", headers, body: JSON.stringify({ origin: "https://phone.example.test" }) }); expect(configured.status).toBe(200); expect((await configured.json()).port).toBeGreaterThan(0);
    expect((await fetch(`${base}/pairing`, { method: "POST", headers, body: "{}" })).status).toBe(200);
  });
});
