import { useEffect, useState } from "react";
import type { Transport } from "../transport.ts";
import { assistantFetch } from "../hooks/useAssistant.ts";
type View = { url: string | null; taskId?: string; expiresAt?: number };
export function CloudBrowser({ transport, visible, running }: { transport: Transport; visible: boolean; running: boolean }) {
  const [view, setView] = useState<View>({ url: null }), [error, setError] = useState(""), [busy, setBusy] = useState(false), [opening, setOpening] = useState(false);
  useEffect(() => {
    if (!visible) return;
    let active = true, fetching = false;
    const refresh = async () => {
      if (fetching) return; fetching = true;
      try { const v = await assistantFetch<View>(transport, "/browser"); if (active) { setView(v); setError(""); if (v.url) setOpening(false); } }
      catch (e) { if (active) setError(e instanceof Error ? e.message : "Browser connection unavailable"); } finally { fetching = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), running || opening ? 1500 : 10000);
    return () => { active = false; clearInterval(timer); };
  }, [transport, visible, running, opening]);
  useEffect(() => { if (!running && opening) { const timer = setTimeout(() => setOpening(false), 20000); return () => clearTimeout(timer); } }, [running, opening]);
  const act = async (route: string) => {
    setBusy(true); setError("");
    try { const v = await assistantFetch<View>(transport, route, {}); setView({ url: v.url ?? null }); setOpening(route.endsWith("open") && !v.url); }
    catch (e) { setError(e instanceof Error ? e.message : "Browser request failed"); } finally { setBusy(false); }
  };
  return <div className="cloud-browser">
    <div className="cloud-toolbar"><span>{running ? "Jarvis is working in this browser" : view.url ? "Your cloud browser · click and type below" : "A separate Browser Use Cloud browser"}{view.url && view.expiresAt && !running ? ` · closes in ${Math.max(1, Math.ceil((view.expiresAt - Date.now()) / 60000))} min` : ""}</span>
      {(view.url || running || opening) && <button disabled={busy} onClick={() => void act("/browser/close")}>Stop browser</button>}
    </div>
    {error && <p className="assistant-error" role="status">{error}</p>}
    {visible && view.url ? <iframe className="browser-view" src={view.url} title="Jarvis browser — click and type" allow="clipboard-read; clipboard-write" /> : <div className="cloud-empty"><strong>{running || opening ? "Connecting Jarvis’s browser…" : "Jarvis’s browser"}</strong><p>Give Jarvis a browser task or open it to browse yourself.</p><button disabled={busy || running || opening} onClick={() => void act("/browser/open")}>{running || opening ? "Connecting…" : "Open browser"}</button><small>Uses your Browser Use credits. Closes 15 minutes after its last task, or when you quit Jarvis.</small></div>}
  </div>;
}
