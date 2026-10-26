import { useEffect, useState } from "react";
import { CONNECTION_FIELDS, type ConnectionKey, type ConnectionSettings } from "../../../core/connections.ts";

export function ConnectionEditor({ onClose }: { onClose(): void }) {
  const [settings, setSettings] = useState<ConnectionSettings>({});
  const [values, setValues] = useState<Partial<Record<ConnectionKey, string>>>({});
  const [remove, setRemove] = useState<ConnectionKey[]>([]);
  const [busy, setBusy] = useState(true);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void window.jev?.connectionSettings?.().then((s) => {
      if (!active) return; setSettings(s);
      setValues(Object.fromEntries(Object.entries(s).filter(([, v]) => v.value !== undefined).map(([k, v]) => [k, v.value])));
    }).catch(() => { if (active) setMessage("Could not open saved settings."); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  const save = async () => {
    setBusy(true); setMessage("");
    try {
      const next = await window.jev!.saveConnections!({ values, remove });
      setSettings(next); setValues(Object.fromEntries(Object.entries(next).filter(([, v]) => v.value !== undefined).map(([k, v]) => [k, v.value]))); setRemove([]); setSaved(true);
      setMessage("Saved privately. Restart Jev to apply your changes.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "Could not save settings."); }
    finally { setBusy(false); }
  };
  return <div className="settings-backdrop"><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title">
    <div className="settings-title"><h2 id="connection-title">Your connections</h2><button type="button" onClick={onClose} aria-label="Close connection settings">Close</button></div>
    <p>Paste a new key to replace it. Empty key fields keep the saved key. Keys stay on this computer.</p>
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} autoComplete="off">
      <div className="connection-fields">{[...new Set(CONNECTION_FIELDS.map((f) => f.group))].map((group) => <fieldset key={group}><legend>{group}</legend>
        {CONNECTION_FIELDS.filter((f) => f.group === group).map((f) => <div className="connection-field" key={f.key}>
          <label htmlFor={`connection-${f.key}`}>{f.label}<span>{remove.includes(f.key) ? "Will remove" : settings[f.key]?.configured ? "Saved" : "Not set"}</span></label>
          <div><input id={`connection-${f.key}`} type={f.secret ? "password" : "text"} autoComplete="off" spellCheck={false} disabled={busy || remove.includes(f.key)} value={values[f.key] || ""} placeholder={f.secret && settings[f.key]?.configured ? "Saved — paste to replace" : f.key === "COMPOSIO_USER_ID" ? "default" : ""} onChange={(e) => { setValues((v) => ({ ...v, [f.key]: e.target.value })); setSaved(false); }} />
          {settings[f.key]?.configured && <button type="button" disabled={busy} onClick={() => { setRemove((r) => r.includes(f.key) ? r.filter((k) => k !== f.key) : [...r, f.key]); setSaved(false); }}>{remove.includes(f.key) ? "Keep" : "Remove"}</button>}</div>
        </div>)}
      </fieldset>)}</div>
      <p className="settings-message" role="status">{message}</p>
      <div className="settings-actions"><button type="submit" disabled={busy}>{busy ? "Please wait…" : "Save connections"}</button>{saved && <button type="button" onClick={() => void window.jev?.restart?.().catch((e: Error) => setMessage(e.message))}>Restart Jev</button>}</div>
    </form>
  </section></div>;
}
