import { useState } from "react";
import type { AssistantStatus, WorkTarget, WorkTask } from "../../../core/assistant.ts";
import type { Transport } from "../transport.ts";
import { assistantFetch } from "../hooks/useAssistant.ts";
import type { useLiveVoice } from "../hooks/useLiveVoice.ts";
import { WORK_TARGET_LABELS } from "../../../core/assistant.ts";
import { ConnectionEditor } from "./ConnectionEditor.tsx";
import { ConnectedApps } from "./ConnectedApps.tsx";
import { VoiceOrb } from "./VoiceOrb.tsx";
import { Permissions } from "./Permissions.tsx";

export function AssistantPanel({ status, error, target, onTarget, voice, transport, refresh, quick, onQuick, onScreen = true }: {
  status: AssistantStatus | null; error: string; target: WorkTarget; onTarget(v: WorkTarget): void;
  voice: ReturnType<typeof useLiveVoice>; transport: Transport; refresh(): Promise<void>; quick: boolean; onQuick(v: boolean): void;
  onScreen?: boolean;
}) {
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingConnections, setEditingConnections] = useState(false);
  const [editingPermissions, setEditingPermissions] = useState(false);
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const act = async (route: string, body: unknown) => {
    setBusy(true); setActionError("");
    try { await assistantFetch(transport, route, body); await refresh(); }
    catch (e) { setActionError(e instanceof Error ? e.message : "Task action failed"); }
    finally { setBusy(false); }
  };
  const c = status?.connections;
  const active = status?.tasks.filter((t) => ["queued", "running", "waiting_for_user"].includes(t.status)).length ?? 0;
  const control = (t: WorkTask, action: string) => void act(`/tasks/${t.id}/control`, { action, correction: corrections[t.id] });
  return <section className="assistant-panel" aria-label="Jarvis assistant">
    {c && (!c.openai || !c.livekit) && <div className="first-run"><strong>Welcome to Jarvis</strong><p>1. Add your OpenAI and LiveKit connections for live conversation.</p><p>2. Add TypeSafe Jev and Browser Use for fast decisions and cloud tasks.</p><p>3. Connect Chrome and allow Mac control when you want Jarvis to act here.</p>{window.jev?.saveConnections && <button type="button" onClick={() => setEditingConnections(true)}>Set up Jarvis</button>}<p>Bring your own accounts. Their voice, model and browser charges are billed separately.</p></div>}
    <div className="assistant-heading"><strong>At your service</strong><span>{active ? `${active} task${active === 1 ? "" : "s"} in progress` : "Ready when you are"}</span></div>
    <label className="work-target">Work in
      <select aria-label="Work environment" value={target} disabled={voice.state === "connecting"} onChange={(e) => { onTarget(e.target.value as WorkTarget); if (e.target.value !== "local") onQuick(false); }}>
        {Object.entries(WORK_TARGET_LABELS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
      </select>
    </label>
    <div className="connection-strip"><span className={c?.chrome ? "ready" : ""}>Chrome {c?.chrome ? "connected" : "not connected"}</span><span className={c?.computer ? "ready" : ""}>Mac {c?.computer ? "connected" : "not connected"}</span></div>
    <div className={`live-voice ${voice.state}`}>
      <VoiceOrb state={voice.state} speaking={voice.speaking} userSpeaking={voice.userSpeaking} visible={onScreen} />
      <button className="live-talk" type="button" onClick={() => void (voice.state === "off" ? voice.start() : voice.stop())}>{voice.state === "connecting" ? "Cancel connection" : voice.state === "on" ? "End conversation" : "Talk to Jarvis"}</button>
      <span>{voice.state === "on" ? "Live conversation · speak and interrupt naturally" : voice.state === "connecting" ? "Connecting LiveKit and GPT-Live…" : "Two-way live voice · no recording or Send button"}</span>
    </div>
    {voice.transcripts.length > 0 && <div className="voice-transcript" aria-live="polite">{voice.transcripts.slice(-3).map((t) => <p key={t.id}><b>{t.who}:</b> {t.text}</p>)}</div>}
    {(voice.error || actionError || error) && <p className="assistant-error" role="status">{voice.error || actionError || error}</p>}
    <details className="connection-settings" onToggle={(e) => setEditingPermissions(e.currentTarget.open)}><summary>Permissions</summary>{editingPermissions && <Permissions transport={transport} />}</details>
    <details className="connection-settings"><summary>Connection settings</summary>
      <p>{c?.openai ? "OpenAI configured" : "OpenAI not connected"} · {c?.livekit ? "LiveKit configured" : "LiveKit not connected"} · {c?.browserUse ? "Cloud browser configured" : "Cloud browser not connected"} · {c?.typesafe ? "Jarvis decisions configured" : "Jarvis decisions not connected"}</p>
      {window.jev?.saveConnections ? <button type="button" onClick={() => setEditingConnections(true)}>Edit connections</button> : <p>Open the desktop app to update your connections.</p>}
      <p>Orgo {c?.orgo ? "configured" : "not connected"} · App tools {c?.composio ? "configured" : "not connected"}</p>
      <ConnectedApps transport={transport} configured={!!c?.composio} />
      {window.jev?.openSettings && <details><summary>Advanced</summary><button type="button" onClick={() => void window.jev?.openSettings?.()}>Show private configuration</button></details>}
      {window.jev?.openExtension && <button type="button" onClick={() => void window.jev?.openExtension?.()}>Show Chrome extension</button>}
      {window.jev?.setupMac && <button type="button" onClick={() => void window.jev?.setupMac?.()}>Set up Mac control</button>}
      <p>For Mac control, allow Cua Driver in System Settings → Privacy &amp; Security → Accessibility and Screen Recording.</p>
      <p>Load the extension folder in Chrome → Extensions → Developer mode → Load unpacked. It pairs with this companion automatically.</p>
      {status?.voiceError && <p>{status.voiceError}</p>}
    </details>
    {editingConnections && <ConnectionEditor onClose={() => setEditingConnections(false)} />}
    <label className="quick-mode"><input type="checkbox" checked={quick} disabled={target !== "local"} onChange={(e) => onQuick(e.target.checked)} /> Instant typed controls (volume, apps, current page)</label>
    <div className="task-list" aria-label="Saved tasks">
      {!status?.tasks.length && <p className="task-empty">Give me a task below. I’ll keep its progress here.</p>}
      {status?.tasks.slice(0, 20).map((t) => <article className={`work-task ${t.status}`} key={t.id}>
        <div className="task-meta"><span>{WORK_TARGET_LABELS[t.target]}</span><b>{t.status.replaceAll("_", " ")}</b></div>
        <p className="task-goal">{t.goal.split("\n\nRecent conversation")[0]}</p>
        <p className="task-progress">{t.error || t.progress}</p>
        {t.approval && <div className="task-approval"><p>{t.approval.summary}</p><button disabled={busy} onClick={() => void act(`/tasks/${t.id}/approve`, { choice: "once", requestId: t.approval!.requestId })}>Allow once</button><button disabled={busy} onClick={() => void act(`/tasks/${t.id}/approve`, { choice: "deny", requestId: t.approval!.requestId })}>Deny</button></div>}
        {!!t.output && <details><summary>Result</summary><div className="task-output">{t.output}</div></details>}
        {!!t.history.length && <details><summary>Progress history</summary>{t.history.slice(-12).map((h, i) => <p className="task-progress" key={i}>{h.text}</p>)}</details>}
        {t.status === "paused" && <input className="task-correction" aria-label="Task correction" placeholder="Add a correction before resuming…" value={corrections[t.id] ?? ""} onChange={(e) => setCorrections((s) => ({ ...s, [t.id]: e.target.value }))} />}
        <div className="task-controls">
          {["running", "queued", "waiting_for_user"].includes(t.status) && <button disabled={busy} onClick={() => control(t, "pause")}>Pause task</button>}
          {["paused", "failed"].includes(t.status) && <button disabled={busy} onClick={() => control(t, "resume")}>Resume</button>}
          {!["completed", "failed", "cancelled"].includes(t.status) && <button disabled={busy} onClick={() => control(t, "cancel")}>Cancel task</button>}
          {t.target === "cloud" && t.status === "running" && <button onClick={() => { void assistantFetch<{ url: string | null }>(transport, `/tasks/${t.id}/live-view`).then((r) => { if (r.url) window.open(r.url, "_blank", "noopener,noreferrer"); else setActionError("The cloud browser is not ready to view yet."); }).catch(() => setActionError("Live view is unavailable")); }}>View browser</button>}
        </div>
      </article>)}
    </div>
  </section>;
}
