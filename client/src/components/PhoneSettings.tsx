import { useEffect, useState } from "react";
import type { Transport } from "../transport.ts";

interface PhoneStatus { origin: string; port: number; error: string; devices: Array<{ id: string; name: string; createdAt: number; expiresAt: number }> }
export function PhoneSettings({ transport }: { transport: Transport }) {
  const [status, setStatus] = useState<PhoneStatus | null>(null), [origin, setOrigin] = useState("");
  const [pairing, setPairing] = useState<{ code: string; url: string; expiresAt: number } | null>(null);
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const call = async <T,>(route: string, body?: unknown): Promise<T> => {
    const res = await fetch(transport.httpUrl(`/phone-access${route}`), { method: body === undefined ? "GET" : "POST", headers: { "X-Jev-UI": "1", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await res.json(); if (!res.ok) throw new Error(data.error || "Phone connection unavailable"); return data as T;
  };
  useEffect(() => { let active = true; void call<PhoneStatus>("/status").then((s) => { if (active) { setStatus(s); setOrigin(s.origin); } }).catch(() => { if (active) setMessage("Phone access is unavailable in this build."); }); return () => { active = false; }; }, [transport]);
  const act = async (fn: () => Promise<void>) => { setBusy(true); setMessage(""); try { await fn(); } catch (e) { setMessage(e instanceof Error ? e.message : "Phone setup failed"); } finally { setBusy(false); } };
  return <section className="phone-settings" aria-label="Phone access">
    <p>Use Jarvis from your iPhone. Tasks run here or in Jarvis’s cloud browser. Keep this Mac awake and Jarvis open.</p>
    <label>Private HTTPS phone address<input aria-label="Phone HTTPS address" placeholder="https://your-mac.your-tailnet.ts.net:9443" value={origin} onChange={(e) => setOrigin(e.target.value)} /></label>
    <button disabled={busy || !status?.port} onClick={() => void act(async () => { const s = await call<PhoneStatus>("/configure", { origin: origin.trim() }); setStatus(s); setOrigin(s.origin); setPairing(null); setMessage(s.origin ? "Phone address saved. Create a pairing code next." : "Phone access disabled and all devices removed."); })}>Save phone address</button>
    {status?.origin && <><p><a href={`${status.origin}/phone`} target="_blank" rel="noreferrer">Open phone app</a></p><button disabled={busy} onClick={() => void act(async () => setPairing(await call("/pairing", {})))}>Create pairing code</button><button disabled={busy} onClick={() => void act(async () => { setStatus(await call("/configure", { origin: "" })); setOrigin(""); setPairing(null); })}>Disable phone access</button></>}
    {pairing && <div className="phone-pairing"><strong>{pairing.code}</strong><p>Open {pairing.url} on your iPhone and enter this code before {new Date(pairing.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. It works once.</p></div>}
    <p>A private HTTPS tunnel must forward to the phone listener on this Mac{status?.port ? ` (127.0.0.1:${status.port})` : ""}. Use Tailscale Serve or an authenticated relay. Forward only the phone listener.</p>
    {status?.devices.map((d) => <p key={d.id}>{d.name} · paired {new Date(d.createdAt).toLocaleDateString()} <button disabled={busy} onClick={() => void act(async () => setStatus(await call("/revoke", { id: d.id })))}>Remove device</button></p>)}
    {(message || status?.error) && <p role="status">{message || status?.error}</p>}
  </section>;
}
