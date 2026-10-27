import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantStatus } from "../../../core/assistant.ts";
import type { Transport } from "../transport.ts";

export async function assistantFetch<T>(transport: Transport, route: string, body?: unknown): Promise<T> {
  const res = await fetch(transport.httpUrl(`/assistant${route}`), { method: body === undefined ? "GET" : "POST", headers: { "X-Jev-UI": "1", "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000) });
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error(data.error || "Jev could not handle that request");
  return data;
}
export function useAssistant(transport: Transport, visible = true) {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [error, setError] = useState("");
  const active = useRef(false);
  const refresh = useCallback(async () => {
    if (active.current) return;
    active.current = true;
    try { setStatus(await assistantFetch<AssistantStatus>(transport, "/status")); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Companion disconnected"); }
    finally { active.current = false; }
  }, [transport]);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), visible ? 1500 : 10000); return () => clearInterval(timer); }, [refresh, visible]);
  return { status, error, refresh };
}
