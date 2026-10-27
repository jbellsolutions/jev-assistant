import { useEffect, useState } from "react";
import type { Transport } from "../transport.ts";
import { assistantFetch } from "../hooks/useAssistant.ts";
type Permission = { slug: string; label: string; connected: boolean; allowed: boolean };
export function Permissions({ transport }: { transport: Transport }) {
  const [actions, setActions] = useState<Permission[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const refresh = () => assistantFetch<{ actions: Permission[] }>(transport, "/permissions").then((r) => setActions(r.actions)).catch((e) => setError(e.message));
  useEffect(() => { void refresh(); }, [transport]);
  const change = async (slug: string, allow: boolean) => {
    setBusy(true); setError("");
    try { await assistantFetch(transport, "/permissions", { slug, allow }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save permission"); } finally { setBusy(false); }
  };
  return <div className="permissions"><p>Allowed actions run without another confirmation on this connected account. Other actions ask first; you can answer by voice.</p>
    {actions.map((p) => <label key={p.slug}><input type="checkbox" checked={p.allowed} disabled={!p.connected || busy} onChange={(e) => void change(p.slug, e.target.checked)} />{p.label}{!p.connected && <small>Connect one account first</small>}</label>)}
    {error && <p role="status">{error}</p>}
  </div>;
}
