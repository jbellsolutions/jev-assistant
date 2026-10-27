import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express, { type Express, type RequestHandler } from "express";
import type { AssistantRuntime } from "./assistant/runtime.js";

const COOKIE = "__Host-jarvis-phone";
const LIFETIME = 30 * 86400000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
interface Device { id: string; name: string; digest: string; expiresAt: number; createdAt: number }
interface Saved { origin: string; devices: Device[] }

/** Separate loopback listener for a TLS tunnel. Never expose the desktop HTTP/WebSocket surface. */
export class PhoneAccess {
  readonly app = express();
  private saved: Saved = { origin: "", devices: [] };
  private pending?: { digest: string; expiresAt: number; attempts: number };
  private file: string;
  private server?: http.Server;
  private port = 0;
  private error = "";
  constructor(private opts: { home: string; clientDir: string; assistant: AssistantRuntime }) {
    mkdirSync(opts.home, { recursive: true, mode: 0o700 });
    this.file = path.join(opts.home, "phone-devices.json");
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Saved;
      if (data.origin) this.validateOrigin(data.origin);
      if (!Array.isArray(data.devices) || data.devices.some((d) => typeof d.id !== "string" || typeof d.name !== "string" || !/^[a-f0-9]{64}$/.test(d.digest) || !Number.isFinite(d.expiresAt) || !Number.isFinite(d.createdAt))) throw new Error("Invalid phone settings");
      this.saved = data;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.error = "Phone settings could not be read. Configure phone access again to reset pairing.";
    }
    this.app.disable("x-powered-by");
    this.app.use((req, res, next) => {
      res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Permissions-Policy": "microphone=(self), camera=()" });
      if (!this.saved.origin) return void res.status(503).json({ error: "Enable phone access in Jarvis on your Mac first." });
      const origin = req.header("origin");
      if (req.header("host") !== new URL(this.saved.origin).host || (origin && origin !== this.saved.origin) || (req.header("x-forwarded-proto") && req.header("x-forwarded-proto") !== "https")) return void res.status(403).json({ error: "Use your configured HTTPS phone link." });
      if (!["GET", "HEAD"].includes(req.method) && (origin !== this.saved.origin || req.header("x-jev-ui") !== "1")) return void res.status(403).json({ error: "Open your Jarvis phone app to make this request." });
      next();
    });
    this.app.use(express.json({ limit: "64kb" }));
    const session = (req: express.Request) => {
      const value = req.header("cookie")?.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      return value ? this.saved.devices.find((d) => d.expiresAt > Date.now() && d.digest === hash(value)) : undefined;
    };
    this.app.get("/phone/session", (req, res) => { const d = session(req); res.json({ paired: !!d, ...(d ? { name: d.name } : {}) }); });
    this.app.post("/phone/pair", (req, res) => {
      const p = this.pending;
      if (!p || p.expiresAt <= Date.now() || ++p.attempts > 10 || typeof req.body?.code !== "string" || hash(req.body.code.replace(/[-\s]/g, "").toUpperCase()) !== p.digest) return void res.status(401).json({ error: "That code is invalid or expired. Create a new code on your Mac." });
      const token = randomBytes(32).toString("base64url");
      const device: Device = { id: randomUUID(), name: String(req.body.name || "iPhone").trim().slice(0, 60) || "iPhone", digest: hash(token), expiresAt: Date.now() + LIFETIME, createdAt: Date.now() };
      const previous = this.saved.devices;
      this.saved.devices = [...previous.filter((d) => d.expiresAt > Date.now()), device];
      if (this.saved.devices.length > 12) { this.saved.devices = previous; return void res.status(400).json({ error: "Remove an old phone on the Mac before pairing another." }); }
      try { this.save(); } catch { this.saved.devices = previous; return void res.status(500).json({ error: "Could not save this device." }); }
      this.pending = undefined;
      res.cookie(COOKIE, token, { secure: true, httpOnly: true, sameSite: "strict", path: "/", maxAge: LIFETIME }).json({ paired: true, name: device.name });
    });
    this.app.post("/phone/logout", async (req, res) => {
      const device = session(req);
      try { if (device) await this.revoke(device.id); res.clearCookie(COOKIE, { secure: true, httpOnly: true, sameSite: "strict", path: "/" }).json({ ok: true }); }
      catch { res.status(500).json({ error: "Device removed; voice cleanup could not be confirmed. Check Jarvis on your Mac." }); }
    });
    opts.assistant.mount(this.app, (req, res, next) => {
      const device = session(req);
      if (!device) return void res.status(401).json({ error: "Pair this phone with Jarvis on your Mac." });
      // Internal worker callbacks, settings, arbitrary API and Chrome/Mac sockets are never tunneled.
      const read = req.method === "GET" && /^\/(?:status|browser|tasks\/[a-zA-Z0-9-]+\/live-view)$/.test(req.path);
      const write = req.method === "POST" && /^\/(?:command|tasks\/[a-zA-Z0-9-]+\/(?:control|approve)|browser\/(?:open|close)|voice\/(?:token|end|connection|target))$/.test(req.path);
      if (!read && !write) return void res.status(403).json({ error: "This action is only available on the Mac." });
      res.locals.phoneDeviceId = device.id;
      res.locals.phoneAuthorized = () => this.saved.devices.some((d) => d.id === device.id && d.expiresAt > Date.now());
      next();
    });
    this.app.use("/assets", express.static(path.join(opts.clientDir, "assets"), { dotfiles: "deny" }));
    for (const name of ["phone.webmanifest", "phone-icon-192.png", "phone-icon-512.png", "apple-touch-icon.png"]) this.app.get(`/${name}`, (_req, res) => res.sendFile(path.join(opts.clientDir, name)));
    for (const route of ["/", "/phone", "/phone/"]) this.app.get(route, (_req, res) => res.sendFile(path.join(opts.clientDir, "index.html")));
    this.app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  }
  private validateOrigin(value: string) {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw new Error("Use an HTTPS address with no path, password or query.");
    return u.origin;
  }
  private save() {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(this.saved), { mode: 0o600, flag: "wx" });
    renameSync(temp, this.file);
  }
  status() { return { origin: this.saved.origin, port: this.port, error: this.error, devices: this.saved.devices.filter((d) => d.expiresAt > Date.now()).map(({ digest: _, ...d }) => d) }; }
  async configure(value: string) {
    const origin = value ? this.validateOrigin(value) : "";
    if (origin !== this.saved.origin) {
      const devices = this.saved.devices;
      const before = this.saved;
      this.saved = { origin, devices: [] };
      try { this.save(); } catch (e) { this.saved = before; throw e; }
      this.pending = undefined;
      for (const d of devices) await this.opts.assistant.endPhoneVoice(d.id);
    } else this.save();
    this.error = "";
    return this.status();
  }
  issueCode() {
    if (!this.saved.origin || !this.port) throw new Error("Set up the HTTPS phone link first.");
    const code = randomBytes(6).toString("hex").toUpperCase();
    const expiresAt = Date.now() + 5 * 60000;
    this.pending = { digest: hash(code), expiresAt, attempts: 0 };
    return { code: code.match(/.{4}/g)!.join("-"), expiresAt, url: `${this.saved.origin}/phone` };
  }
  async revoke(id: string) {
    const before = this.saved.devices;
    this.saved.devices = before.filter((d) => d.id !== id);
    try { this.save(); } catch (e) { this.saved.devices = before; throw e; }
    await this.opts.assistant.endPhoneVoice(id);
  }
  mountDesktop(app: Express, authorize: RequestHandler) {
    const router = express.Router(); router.use(authorize, express.json({ limit: "4kb" }));
    const handle = (fn: (req: express.Request, res: express.Response) => unknown): RequestHandler => (req, res) => { void Promise.resolve().then(() => fn(req, res)).catch(() => res.status(400).json({ error: "Could not update phone access. Use a valid HTTPS address and check the private settings folder." })); };
    router.get("/status", (_req, res) => res.json(this.status()));
    router.post("/configure", handle(async (req, res) => { if (typeof req.body?.origin !== "string") throw new Error("Address required"); res.json(await this.configure(req.body.origin)); }));
    router.post("/pairing", handle((_req, res) => res.json(this.issueCode())));
    router.post("/revoke", handle(async (req, res) => { if (typeof req.body?.id !== "string") throw new Error("Device required"); await this.revoke(req.body.id); res.json(this.status()); }));
    app.use("/phone-access", router);
  }
  async listen(port: number) {
    const server = http.createServer(this.app); this.server = server;
    server.on("upgrade", (_req, socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
      this.port = (server.address() as AddressInfo).port;
    } catch { this.error = "The phone connection port is busy. Close the other Jarvis instance and restart."; }
  }
  async close() { if (this.server?.listening) await new Promise<void>((r) => this.server!.close(() => r())); }
}
