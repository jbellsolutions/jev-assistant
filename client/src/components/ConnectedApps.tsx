import { useState } from "react";
import type { Transport } from "../transport.ts";
import { assistantFetch } from "../hooks/useAssistant.ts";
export function ConnectedApps({ transport, configured }: { transport: Transport; configured: boolean }) {
  const [apps, setApps] = useState<Array<{ slug: string; connected: boolean; accounts: number; ambiguous?: boolean }>>([]);
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true); setMessage("");
    try { setApps((await assistantFetch<{ apps: typeof apps }>(transport, "/apps")).apps); }
    catch { setMessage("Could not load connected apps. Check the Composio project key and user ID."); }
    finally { setBusy(false); }
  };
  const connect = async (slug: string) => {
    setBusy(true); setMessage("");
    try {
      const r = await assistantFetch<{ url: string }>(transport, "/apps/connect", { toolkit: slug });
      window.open(r.url, "_blank", "noopener,noreferrer");
      setMessage("Finish connecting in your browser, then refresh the app list. New tasks will use the connection.");
    } catch { setMessage("Could not start app connection. Check your Composio project settings."); }
    finally { setBusy(false); }
  };
  return <div className="connected-apps"><h4>Connected apps</h4>
    <p>{configured ? "Use app tools with My computer or Co-founder's computer. Sends and changes ask for approval." : "Add your Composio project key in Your connections, then restart Jev."}</p>
    <button type="button" disabled={!configured || busy} onClick={() => void refresh()}>Refresh connected apps</button>
    {apps.map((a) => <div className="connected-app-row" key={a.slug}><span>{a.slug} · {a.ambiguous ? "Multiple accounts: choose a Composio user with one account" : a.connected ? "Connected" : "Not connected"}</span>{!a.connected && !a.ambiguous && <button type="button" disabled={busy} onClick={() => void connect(a.slug)}>Connect {a.slug}</button>}</div>)}
    {message && <p role="status">{message}</p>}
  </div>;
}
