import { useCallback, useEffect, useRef, useState } from "react";
import type { Transport } from "../transport.ts";
import { assistantFetch } from "../hooks/useAssistant.ts";
interface Frame { frameId: string; at: number; title: string; jpegBase64: string; canControl: boolean; controlMessage: string }
export function PhoneMacScreen({ transport, visible }: { transport: Transport; visible: boolean }) {
  const [frame, setFrame] = useState<Frame | null>(null), [error, setError] = useState("");
  const [controlling, setControlling] = useState(false), [busy, setBusy] = useState(false), [zoom, setZoom] = useState(false), [text, setText] = useState("");
  const pending = useRef(false), active = useRef(visible); active.current = visible;
  const refresh = useCallback(async () => {
    if (pending.current || !active.current) return;
    pending.current = true; setBusy(true);
    try { const next = await assistantFetch<Frame>(transport, "/mac/screen"); if (active.current) { setFrame(next); setError(""); } }
    catch (e) { if (active.current) { setFrame(null); setError(e instanceof Error ? e.message : "Mac screen unavailable"); } }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }, [transport]);
  useEffect(() => {
    active.current = visible;
    if (!visible) { setFrame(null); setControlling(false); return; }
    void refresh(); const timer = setInterval(() => void refresh(), 2500);
    return () => { clearInterval(timer); active.current = false; };
  }, [visible, refresh]);
  const input = async (body: Record<string, unknown>) => {
    if (pending.current || !frame || !frame.canControl || !controlling) return;
    pending.current = true; setBusy(true); setError("");
    try { await assistantFetch(transport, "/mac/input", { ...body, frameId: frame.frameId, requestId: crypto.randomUUID() }); if (body.action === "text") setText(""); }
    catch (e) { setError(`${e instanceof Error ? e.message : "Input was not confirmed."} Check the refreshed picture before repeating an action.`); }
    finally { pending.current = false; setBusy(false); }
    // Never replay an input after a timeout; inspect the new state instead.
    if (active.current) {
      pending.current = true; setBusy(true);
      try { const next = await assistantFetch<Frame>(transport, "/mac/screen"); if (active.current) setFrame(next); }
      catch { if (active.current) setFrame(null); }
      finally { pending.current = false; if (active.current) setBusy(false); }
    }
  };
  const enabled = controlling && !!frame?.canControl && !busy && !!frame && Date.now() - frame.at < 12000;
  return <section className="phone-mac" aria-label="Mac screen">
    <h1>Your Mac at home</h1><p>See the Mac window Jarvis is working in, or the app in front. Talk and typed Mac requests use the same desktop tools.</p>
    <div className="phone-mac-toolbar"><button disabled={busy} onClick={() => void refresh()}>Refresh picture</button><button aria-pressed={zoom} onClick={() => setZoom((v) => !v)}>{zoom ? "Fit picture" : "Zoom picture"}</button></div>
    <div className="phone-mac-picture">{frame ? <img style={zoom ? { width: "200%", maxWidth: "none" } : undefined} src={`data:image/jpeg;base64,${frame.jpegBase64}`} alt={`Mac window: ${frame.title || "current app"}`} draggable={false} onClick={(e) => { if (!enabled) return; const r = e.currentTarget.getBoundingClientRect(); void input({ action: "click", fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height }); }} /> : <p role="status">{busy ? "Checking the Mac’s screen…" : "No Mac picture available."}</p>}</div>
    {frame && <><p className="phone-mac-caption">{frame.title || "Mac window"} · picture checked {new Date(frame.at).toLocaleTimeString()}</p><p>{frame.controlMessage}</p></>}
    {error && <p className="phone-error" role="status">{error}</p>}
    <label className="phone-manual"><input type="checkbox" checked={controlling} disabled={!frame?.canControl} onChange={(e) => setControlling(e.target.checked)} />Control this Mac window</label>
    {controlling && <div className="phone-manual-controls"><p>Tap the picture to click. These controls act directly in the pictured Mac window. Pause any active Mac task first.</p><label>Text for the selected field<textarea aria-label="Text for Mac" value={text} maxLength={4000} rows={2} onChange={(e) => setText(e.target.value)} /></label><button disabled={!enabled || !text} onClick={() => void input({ action: "text", text })}>Type on Mac</button><div className="phone-mac-keys">{["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "cmd+a", "cmd+f", "cmd+o", "cmd+shift+g"].map((key) => <button key={key} disabled={!enabled} onClick={() => void input({ action: "key", key })}>{({ ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", "cmd+a": "Select all", "cmd+f": "Find", "cmd+o": "Open", "cmd+shift+g": "Go to folder" } as Record<string, string>)[key] || key}</button>)}</div></div>}
  </section>;
}
