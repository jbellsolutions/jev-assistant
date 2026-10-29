import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkTarget, WorkTask } from "../../core/assistant.ts";
import { detectTransport, type Transport } from "./transport.ts";
import { assistantFetch, useAssistant } from "./hooks/useAssistant.ts";
import { useLiveVoice } from "./hooks/useLiveVoice.ts";
import { VoiceInput } from "./components/VoiceInput.tsx";
import { VoiceOrb } from "./components/VoiceOrb.tsx";
import { CloudBrowser } from "./components/CloudBrowser.tsx";
import { PhoneMacScreen } from "./components/PhoneMacScreen.tsx";
import "./phone.css";

async function phoneFetch<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`/phone/${route}`, { method: body === undefined ? "GET" : "POST", headers: { "X-Jev-UI": "1", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || "Your Mac could not be reached."); return data as T;
}
export function PhoneApp() {
  const [paired, setPaired] = useState<boolean | null>(null), [code, setCode] = useState(""), [name, setName] = useState("My iPhone");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const check = () => { void phoneFetch<{ paired: boolean }>("session").then((s) => { setPaired(s.paired); setError(""); }).catch(() => setError("Can’t reach Jarvis. Check your private connection and make sure your Mac is awake with Jarvis open.")); };
  useEffect(check, []);
  const transport = useMemo(() => detectTransport(), []);
  return <main className="phone-app">
    <header className="phone-header"><a href="/phone" aria-label="Jarvis home"><span className="phone-mark" />Jarvis</a><span>YOUR DESKTOP, WITH YOU</span></header>
    {paired ? <ConnectedPhone transport={transport} onUnpair={() => setPaired(false)} /> : <section className="phone-welcome">
      <div className="phone-kicker">AT YOUR SERVICE</div><h1>Big ideas.<br />From anywhere.</h1><p>Your Jarvis at home, a tap away. Talk, give it work, and pick up where you left off.</p>
      <VoiceOrb state="off" speaking={false} userSpeaking={false} />
      {paired === false && <form className="phone-pair-form" onSubmit={(e) => { e.preventDefault(); setBusy(true); setError(""); void phoneFetch("pair", { code, name }).then(() => { setCode(""); setPaired(true); }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false)); }}>
        <h2>Connect to your Mac</h2><p>On Jarvis for Mac, open <b>Connect iPhone</b> and create a pairing code.</p>
        <label>Device name<input autoComplete="nickname" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></label>
        <label>Pairing code<input className="phone-code" autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" placeholder="ABCD-1234-EF56" value={code} onChange={(e) => setCode(e.target.value)} required maxLength={20} /></label>
        <button className="phone-primary" disabled={busy}>{busy ? "Connecting…" : "Connect to Jarvis"}</button>
      </form>}
      {paired === null && !error && <p role="status">Connecting to your Mac…</p>}
      {error && <div role="status" className="phone-error">{error}<button onClick={check}>Try again</button></div>}
      <p className="phone-footnote">After connecting, use Safari → Share → Add to Home Screen. You may need to pair once more when opening the Home Screen app.</p>
    </section>}
  </main>;
}

function ConnectedPhone({ transport, onUnpair }: { transport: Transport; onUnpair(): void }) {
  const [visible, setVisible] = useState(!document.hidden), [target, setTarget] = useState<WorkTarget>(() => { try { const t = localStorage.getItem("jarvis-phone-target"); return t === "cloud" || t === "orgo" ? t : "local"; } catch { return "local"; } });
  const [tab, setTab] = useState<"talk" | "tasks" | "browser" | "mac">("talk");
  const { status, error, refresh } = useAssistant(transport, visible);
  const voice = useLiveVoice(transport, target, false, false);
  const [text, setText] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const request = useRef<{ text: string; target: WorkTarget; id: string } | null>(null);
  const voiceRef = useRef(voice); voiceRef.current = voice;
  useEffect(() => {
    const change = () => { setVisible(!document.hidden); if (document.hidden) void voiceRef.current.stop(); else { void refresh(); void phoneFetch<{ paired: boolean }>("session").then((s) => { if (!s.paired) onUnpair(); }).catch(() => {}); } };
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, [refresh, onUnpair]);
  // A revoked/expired cookie ends access and any local media capture promptly.
  useEffect(() => { if (!error) return; void phoneFetch<{ paired: boolean }>("session").then((s) => { if (!s.paired) { void voiceRef.current.stop(); onUnpair(); } }).catch(() => {}); }, [error, onUnpair]);
  const act = async (route: string, body: unknown) => {
    setBusy(true); setMessage("");
    try { await assistantFetch(transport, route, body); await refresh(); }
    catch (e) { setMessage(e instanceof Error ? e.message : "Request failed. Check the task before trying again."); }
    finally { setBusy(false); }
  };
  const tasks = status?.tasks ?? [];
  const active = tasks.filter((t) => ["running", "queued", "waiting_for_user"].includes(t.status)).length;
  const approvals = tasks.filter((t) => !!t.approval).length;
  const connected = !!status && !error;
  const chooseTarget = async (next: WorkTarget) => {
    if (next === target) return;
    if (voice.state === "on") await voice.changeTarget(next);
    setTarget(next); try { localStorage.setItem("jarvis-phone-target", next); } catch {}
  };
  const send = async () => {
    const goal = text.trim(); if (!goal || busy || !connected) return;
    if (request.current?.text !== goal || request.current?.target !== target) request.current = { text: goal, target, id: crypto.randomUUID() };
    setBusy(true); setMessage("");
    try { const r = await assistantFetch<{ message: string }>(transport, "/command", { text: goal, target, requestId: request.current.id }); setText(""); request.current = null; setMessage(r.message); await refresh(); }
    catch { setMessage("Couldn’t confirm receipt. Check Tasks before retrying. Retry sends the same request ID."); }
    finally { setBusy(false); }
  };
  return <>
    <div className={`phone-connection ${connected ? "connected" : ""}`} role="status"><span />{connected ? "Connected to your Mac" : "Reconnecting to your Mac…"}<button onClick={() => { if (voice.state !== "off") { setMessage("End your conversation before disconnecting this phone."); return; } setBusy(true); void phoneFetch("logout", {}).then(onUnpair).catch((e: Error) => setMessage(e.message)).finally(() => setBusy(false)); }} disabled={busy}>Disconnect</button></div>
    <nav className="phone-tabs" aria-label="Jarvis views">{(["talk", "tasks", "mac", "browser"] as const).map((t) => <button key={t} disabled={voice.state === "connecting" || busy} aria-current={tab === t ? "page" : undefined} onClick={() => { void (t === "mac" ? chooseTarget("local") : t === "browser" ? chooseTarget("cloud") : Promise.resolve()).then(() => setTab(t)).catch((e: Error) => setMessage(e.message)); }}>{t === "talk" ? "Talk" : t === "tasks" ? `Tasks${approvals ? ` · ${approvals} to review` : active ? ` · ${active}` : ""}` : t === "mac" ? "Mac" : "Browser"}</button>)}</nav>
    <section className="phone-content">
      <label className="phone-target">WORK IN<select aria-label="Work environment" value={target} disabled={voice.state === "connecting" || busy} onChange={(e) => { void chooseTarget(e.target.value as WorkTarget).catch((e: Error) => setMessage(e.message)); }}><option value="local">My computer at home</option><option value="cloud">Jarvis browser</option>{status?.connections.orgo && <option value="orgo">Co-founder’s computer</option>}</select></label>
      {target === "local" && <p className="phone-mac-readiness">Mac controls {status?.connections.computer ? "available" : "unavailable — check Cua Driver permissions on the Mac"} · Chrome {status?.connections.chrome ? "connected" : "not connected"}. Open the Mac tab to verify the live picture.</p>}
      {tab === "talk" && <>
        <section className="phone-conversation"><div className="phone-kicker">AT YOUR SERVICE</div><h1>{voice.state === "on" ? voice.inputProblem ? "Check your microphone." : "I’m listening." : "What’s on your mind?"}</h1><p>{target === "local" ? "Jarvis will work on your Mac at home." : target === "orgo" ? "Jarvis will work on the co-founder’s computer." : "Jarvis will look things up and work in its own browser."}</p>
          <VoiceOrb state={voice.state} speaking={voice.speaking} userSpeaking={voice.userSpeaking} inputProblem={voice.inputProblem} visible={visible} />
          <button className={`phone-primary phone-talk ${voice.state}`} disabled={!connected && voice.state === "off"} onClick={() => void (voice.state === "off" ? voice.start() : voice.stop())}>{voice.state === "off" ? "Talk to Jarvis" : voice.state === "connecting" ? "Cancel connection" : "End conversation"}</button>
          {voice.needsAudio && <button onClick={() => void voice.enableAudio()}>Tap to enable sound</button>}
          <VoiceInput voice={voice} />
          <small>Voice ends when you leave this app. Your tasks keep running.</small>
        </section>
        {!!voice.transcripts.length && <div className="phone-transcripts" aria-live="polite">{voice.transcripts.map((t) => <p key={t.id}><b>{t.who === "Jev" ? "Jarvis" : t.who}</b>{t.text}</p>)}</div>}
        <form className="phone-compose" onSubmit={(e) => { e.preventDefault(); void send(); }}><label htmlFor="phone-task">Or give me a task</label><textarea id="phone-task" placeholder={target === "local" ? "On my Mac, open…" : "Look up…"} value={text} maxLength={12000} rows={3} onChange={(e) => setText(e.target.value)} /><button className="phone-primary" disabled={busy || !connected || !text.trim()}>{busy ? "Saving…" : "Give Jarvis this task"}</button></form>
        {approvals > 0 && <button className="phone-review" onClick={() => setTab("tasks")}>{approvals} action{approvals === 1 ? " needs" : "s need"} your approval →</button>}
      </>}
      {tab === "tasks" && <section className="phone-tasks" aria-label="Saved tasks"><div className="phone-section-title"><h1>Your tasks</h1><button onClick={() => void refresh()}>Refresh</button></div><p>Shared with Jarvis on your Mac.</p>{!tasks.length && <div className="phone-empty">Nothing here yet. Give Jarvis a task to get started.</div>}{tasks.slice(0, 30).map((task) => <PhoneTask key={task.id} task={task} disabled={busy || !connected} act={act} />)}</section>}
      {tab === "browser" && <section className="phone-browser"><h1>Jarvis’s browser</h1><p>The same cloud browser you see on your Mac.</p><CloudBrowser transport={transport} visible={visible} running={tasks.some((t) => t.target === "cloud" && t.status === "running")} /></section>}
      {tab === "mac" && <PhoneMacScreen transport={transport} visible={visible} />}
      {(voice.error || error || message) && <p className="phone-error" role="status">{voice.error || error || message}</p>}
      <footer className="phone-footnote">Your Mac must stay awake with Jarvis running. Connected apps and approvals work just as they do at home.</footer>
    </section>
  </>;
}
function PhoneTask({ task: t, disabled, act }: { task: WorkTask; disabled: boolean; act(route: string, body: unknown): Promise<void> }) {
  const [correction, setCorrection] = useState("");
  return <article className={`phone-task ${t.status}`}><div className="phone-task-meta"><span>{t.target === "local" ? "MAC AT HOME" : t.target === "cloud" ? "JARVIS BROWSER" : "CO-FOUNDER"}</span><b>{t.status === "completed" ? "Worker finished" : t.status.replaceAll("_", " ")}</b></div><h2>{t.goal.split("\n\nRecent conversation")[0]}</h2><p>{t.error || t.progress}</p>
    {t.approval && <div className="phone-approval"><b>Needs your approval</b><p>{t.approval.summary}</p><div><button className="phone-primary" disabled={disabled} onClick={() => void act(`/tasks/${t.id}/approve`, { choice: "once", requestId: t.approval!.requestId })}>Allow once</button><button disabled={disabled} onClick={() => void act(`/tasks/${t.id}/approve`, { choice: "deny", requestId: t.approval!.requestId })}>Deny</button></div></div>}
    {t.output && <details><summary>View result</summary><p className="phone-output">{t.output}</p></details>}
    {(t.status === "paused" || t.status === "failed") && <label>Correction (optional)<input value={correction} onChange={(e) => setCorrection(e.target.value)} placeholder="Before you continue…" /></label>}
    <div className="phone-task-controls">{["queued", "running", "waiting_for_user"].includes(t.status) && <button disabled={disabled} onClick={() => void act(`/tasks/${t.id}/control`, { action: "pause" })}>Pause</button>}{["paused", "failed"].includes(t.status) && <button disabled={disabled} onClick={() => void act(`/tasks/${t.id}/control`, { action: "resume", correction })}>Resume</button>}{!["completed", "failed", "cancelled"].includes(t.status) && <button disabled={disabled} onClick={() => void act(`/tasks/${t.id}/control`, { action: "cancel" })}>Cancel task</button>}</div>
  </article>;
}
