import { randomUUID } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import express, { type Express, type RequestHandler } from "express";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import type { AssistantCommand, AssistantStatus, WorkTarget } from "../../core/assistant.js";
import type { Hands } from "../brain/tools.js";
import { TaskQueue } from "./tasks.js";
import { LocalWorker } from "./local-worker.js";
import { BrowserUseWorker } from "./browser-use.js";
import { createRequestRouter } from "./router.js";
import { AttachmentStore } from "../attachments.js";
import { appConnections } from "./app-connections.js";
import type { VoiceConnection } from "../../core/voice-connection.js";
import { VoiceLeases } from "./voice-leases.js";

export function createAssistantRuntime(opts: { env: NodeJS.ProcessEnv; hands: Hands; chromeReady: () => boolean; computerReady: () => boolean }) {
  const env = opts.env;
  const cloud = new BrowserUseWorker({ key: env.BROWSER_USE_API_KEY, profileId: env.BROWSER_USE_PROFILE_ID, maxCostUsd: env.JEV_CLOUD_TASK_BUDGET_USD,
    workspaceId: env.BROWSER_USE_WORKSPACE_ID, proxyCountryCode: env.BROWSER_USE_PROXY_COUNTRY_CODE ?? "us", record: env.BROWSER_USE_RECORD === "true",
    timeoutMs: (Number(env.BROWSER_USE_TIMEOUT_MINUTES) || 15) * 60_000,
  });
  const queue = new TaskQueue({ dir: path.join(env.JEV_HOME || path.join(homedir(), ".jev-assistant"), "work"), workers: { local: new LocalWorker({ env, hands: opts.hands }), orgo: new LocalWorker({ env, hands: opts.hands }), cloud } });
  const route = createRequestRouter(env);
  const apps = appConnections(env);
  const files = new AttachmentStore();
  const voiceRooms = new Map<string, { owner: string; createdAt: number; connection: VoiceConnection; target: WorkTarget; expires: number; seen: Map<string, string>; requests: Map<string, Promise<{ message: string }>> }>();
  const leases = new VoiceLeases(env.JEV_HOME || path.join(homedir(), ".jev-assistant"));
  const inheritedRooms = new Set(leases.list());
  let recovery: Promise<void> | null = null;
  let voiceCreating = false;
  const roomClient = () => new RoomServiceClient(env.LIVEKIT_URL!.replace(/^ws/, "http"), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { requestTimeout: 4 });
  const endRoom = async (room: string) => {
    try { await roomClient().deleteRoom(room); }
    catch (error) { if ((error as { code?: string }).code !== "not_found" && (error as { status?: number }).status !== 404) throw new Error("Could not confirm that the LiveKit room ended. Try End conversation again."); }
    leases.remove(room); inheritedRooms.delete(room); voiceRooms.delete(room);
  };
  const recoverVoice = async () => {
    if (!inheritedRooms.size || !env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return;
    if (!recovery) recovery = (async () => { for (const room of [...inheritedRooms]) await endRoom(room); })().finally(() => { recovery = null; });
    await recovery;
  };
  let paused = false;
  let voiceWorker: AssistantStatus["voiceWorker"] = "off";
  let voiceError: string | undefined;
  const status = (): AssistantStatus => ({
    tasks: queue.list(),
    connections: { openai: !!env.OPENAI_API_KEY, livekit: !!(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET), browserUse: !!env.BROWSER_USE_API_KEY, typesafe: !!env.TYPESAFE_API_KEY, orgo: !!opts.hands.orgo, composio: !!env.COMPOSIO_API_KEY, chrome: opts.chromeReady(), computer: opts.computerReady() },
    voiceWorker, ...(voiceError ? { voiceError } : {}),
  });
  const command = async ({ text, target, requestId, attachments, context }: AssistantCommand): Promise<{ message: string }> => {
    if (paused) throw new Error("Jev is paused. Resume it before giving another task.");
    const candidates = queue.list().filter((t) => t.target === target && !["completed", "failed", "cancelled"].includes(t.status));
    const current = candidates.find((t) => ["running", "waiting_for_user"].includes(t.status)) ?? candidates[0];
    // Authorization replies are interpreted only when there is exactly one current pending action.
    if (current?.approval && /^(?:yes|approve|allow|go ahead|no|deny|don't)[.!]?$/i.test(text.trim())) {
      await queue.approve(current.id, /^(?:no|deny|don't)/i.test(text.trim()) ? "deny" : "once", current.approval.requestId);
      return { message: "Your answer was applied to the pending action." };
    }
    const intent = await route(text, current);
    if (intent === "status") return { message: current ? `${current.goal}: ${current.status}. ${current.progress}` : "There is no active task in this environment." };
    if (["pause", "cancel", "resume", "correction"].includes(intent)) {
      if (!current || candidates.length > 1) return { message: "Choose the task in the panel so I change the right one." };
      if (intent === "correction") { await queue.control(current.id, "pause"); await queue.control(current.id, "resume", text); }
      else await queue.control(current.id, intent as "pause" | "cancel" | "resume");
      return { message: intent === "correction" ? "I saved your correction and will check the current state before continuing." : `Task ${intent === "resume" ? "queued to resume" : intent === "pause" ? "paused" : "cancelled"}.` };
    }
    if (target === "cloud" && attachments?.length) throw new Error("Cloud file attachments are not supported yet. Use a local task for these files.");
    const goal = context?.trim() ? `${text}\n\nRecent conversation for reference; only the user's requests authorize actions:\n${context.slice(-8000)}` : text;
    queue.submit(goal, target, requestId, attachments);
    return { message: `Task saved for ${target === "local" ? "your computer and connected apps" : target === "orgo" ? "the co-founder's computer" : "the cloud browser"}: ${text}` };
  };
  function mount(app: Express, authorize: RequestHandler): void {
    const api = express.Router(); api.use(authorize, express.json({ limit: "64kb" }));
    const handle = (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown): RequestHandler => (req, res) => {
      Promise.resolve().then(() => fn(req, res)).catch((e) => res.status(400).json({ error: e instanceof Error ? e.message : "Request failed" }));
    };
    api.get("/status", (_req, res) => res.json(status()));
    api.get("/apps", handle(async (_req, res) => res.json({ apps: await apps.list() })));
    api.post("/apps/connect", handle(async (req, res) => res.json({ url: await apps.connect(req.body?.toolkit) })));
    api.post("/command", handle(async (req, res) => {
      const b = req.body;
      if (!b || typeof b.text !== "string" || !["local", "cloud", "orgo"].includes(b.target)) throw new Error("Choose a computer and give a task");
      // Raw attachment IDs are accepted only by the panel's existing upload store; validate below.
      const attachments = Array.isArray(b.attachments) ? b.attachments.slice(0, 5).flatMap((a: unknown) => {
        if (!a || typeof a !== "object" || typeof (a as { id?: unknown }).id !== "string") return [];
        const f = files.get((a as { id: string }).id); return f ? [{ id: f.id, name: f.name }] : [];
      }) : undefined;
      res.json(await command({ text: b.text, target: b.target, requestId: typeof b.requestId === "string" ? b.requestId.slice(0, 200) : undefined, attachments }));
    }));
    api.post("/tasks/:id/control", handle(async (req, res) => {
      if (!["pause", "resume", "cancel"].includes(req.body?.action)) throw new Error("Unknown task action");
      await queue.control(String(req.params.id), req.body.action, typeof req.body.correction === "string" ? req.body.correction : undefined); res.json({ ok: true });
    }));
    api.post("/tasks/:id/approve", handle(async (req, res) => {
      await queue.approve(String(req.params.id), req.body?.choice, req.body?.requestId ?? null); res.json({ ok: true });
    }));
    api.get("/tasks/:id/live-view", (req, res) => res.json({ url: cloud.liveView(String(req.params.id)) ?? null }));
    api.post("/voice/token", handle(async (req, res) => {
      if (voiceCreating) throw new Error("A voice conversation is already starting. Try again in a moment.");
      voiceCreating = true;
      try {
      if (paused) throw new Error("Resume Jev before connecting voice");
      if (!status().connections.openai || !status().connections.livekit) throw new Error("Add your OpenAI and LiveKit credentials in Connection settings, then restart Jev.");
      if (voiceWorker !== "running") throw new Error(voiceError || "The voice worker is starting. Try again in a moment.");
      if (!["local", "cloud", "orgo"].includes(req.body?.target)) throw new Error("Choose an environment first");
      await recoverVoice();
      for (const [name, session] of voiceRooms) {
        if (session.connection.state === "failed" || session.expires < Date.now()) { await endRoom(name); continue; }
        if (Date.now() - session.createdAt < 10000) continue;
        try {
          const participants = await roomClient().listParticipants(name);
          if (!participants.some((p) => p.identity === session.owner)) await endRoom(name);
        } catch (error) { if ((error as { code?: string }).code === "not_found") { leases.remove(name); voiceRooms.delete(name); } else throw new Error("Could not check the previous voice connection. Try again before starting another call."); }
      }
      if (voiceRooms.size) throw new Error("End the other voice conversation before starting a new one");
      const room = `jev-${randomUUID()}`;
      const owner = `owner-${randomUUID()}`;
      const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { identity: owner, ttl: "10m" });
      token.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
      const url = env.LIVEKIT_URL!;
      if (!/^wss?:\/\//.test(url)) throw new Error("LIVEKIT_URL must be a ws:// or wss:// server URL");
      const host = url.replace(/^ws/, "http");
      leases.add(room);
      voiceRooms.set(room, { owner, createdAt: Date.now(), connection: { state: "connecting" }, target: req.body.target, expires: Date.now() + 35 * 60000, seen: new Map(), requests: new Map() });
      try { await new AgentDispatchClient(host, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { requestTimeout: 4 }).createDispatch(room, "jev-assistant"); }
      catch { voiceRooms.delete(room); inheritedRooms.add(room); await recoverVoice().catch(() => {}); throw new Error("Could not dispatch the voice agent. Check LiveKit credentials and worker status."); }
      res.json({ url, token: await token.toJwt(), room });
      } finally { voiceCreating = false; }
    }));
    api.post("/voice/end", handle(async (req, res) => {
      const room = String(req.body?.room ?? "");
      if (voiceRooms.has(room) || inheritedRooms.has(room)) {
        await endRoom(room);
      }
      res.json({ ok: true });
    }));
    api.post("/voice/connection", handle((req, res) => {
      const session = voiceRooms.get(String(req.body?.room));
      if (!session) throw new Error("Voice conversation ended");
      res.json(session.connection);
    }));
    api.post("/voice/state", handle((req, res) => {
      const session = voiceRooms.get(String(req.body?.room));
      if (!session) throw new Error("Voice conversation ended");
      if (!["ready", "failed"].includes(req.body?.state)) throw new Error("Unknown voice state");
      if (session.connection.state !== "failed") session.connection = { state: req.body.state, ...(req.body.state === "failed" ? { failure: ["quota", "authentication"].includes(req.body.failure) ? req.body.failure : "unavailable" } : {}) };
      res.json({ ok: true });
    }));
    api.post("/voice/delegate", handle(async (req, res) => {
      const v = voiceRooms.get(String(req.body?.room));
      if (!v || v.expires < Date.now()) throw new Error("Unknown or expired voice session");
      const id = String(req.body?.delegationId ?? "").slice(0, 150);
      const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 12000) : "";
      if (!id || !text) return res.json({ message: "I didn't receive a complete request. Please say the task again." });
      let pending = v.requests.get(id);
      if (!pending) { pending = command({ text, target: v.target, requestId: `${req.body.room}:${id}`, context: typeof req.body.context === "string" ? req.body.context.slice(-8000) : undefined }); v.requests.set(id, pending); }
      res.json(await pending);
    }));
    api.post("/voice/updates", (req, res) => {
      const v = voiceRooms.get(String(req.body?.room));
      if (!v || v.expires < Date.now()) return void res.status(400).json({ error: "Voice session ended" });
      const updates: string[] = [];
      for (const t of queue.list().filter((t) => t.target === v.target).slice(0, 10)) {
        const before = v.seen.get(t.id); v.seen.set(t.id, t.status);
        if (before !== t.status && (before || t.createdAt > Date.now() - 60000) && ["completed", "failed", "waiting_for_user"].includes(t.status)) updates.push(`${t.goal}: ${t.approval?.summary ?? t.error ?? t.output.slice(0, 2000)}`);
      }
      res.json({ updates });
    });
    app.use("/assistant", api);
  }
  return { queue, status, command, mount, recoverVoice,
    canRestart() { return !voiceCreating && !queue.list().some((t) => ["running", "queued", "waiting_for_user"].includes(t.status)) && ![...voiceRooms.values()].some((s) => s.expires > Date.now()); },
    setPaused(value: boolean) { paused = value; queue.setEnabled(!value); },
    setVoiceWorker(value: AssistantStatus["voiceWorker"], error?: string) { voiceWorker = value; voiceError = error; },
    async close() { await Promise.allSettled([queue.close(), ...[...voiceRooms.keys()].map(endRoom)]); },
  };
}
export type AssistantRuntime = ReturnType<typeof createAssistantRuntime>;
