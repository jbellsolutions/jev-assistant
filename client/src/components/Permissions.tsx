import { useEffect, useState } from "react";
import type { Transport } from "../transport.ts";
import { assistantFetch } from "../hooks/useAssistant.ts";
export function Permissions({ transport }: { transport: Transport }) {
  const [enabled, setEnabled] = useState<boolean | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; void assistantFetch<{ enabled: boolean }>(transport, "/permissions").then((r) => { if (active) setEnabled(r.enabled); }).catch((e) => { if (active) setError(e.message); }); return () => { active = false; }; }, [transport]);
  const change = async () => {
    if (enabled === null) return;
    setBusy(true); setError("");
    try { const r = await assistantFetch<{ enabled: boolean }>(transport, "/permissions", { enabled: !enabled }); setEnabled(r.enabled); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save permissions"); } finally { setBusy(false); }
  };
  return <div className="permissions"><p><strong>Permissions enabled: {enabled === null ? "Loading…" : enabled ? "Yes" : "No"}</strong></p>
    <p>{enabled === false ? "Enable permissions to let Jarvis carry out your tasks. Turning permissions off pauses active tasks." : "Jarvis can carry out your requests on the selected computer, in the browser and through connected apps. Your Mac and account connections must be available."}</p>
    <button type="button" disabled={enabled === null || busy} onClick={() => void change()}>{busy ? "Saving…" : enabled ? "Turn permissions off" : "Enable permissions"}</button>
    {error && <p role="status">{error}</p>}
  </div>;
}
