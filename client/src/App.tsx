import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

const LOG_KEY = "jev.log";

function savedLog(): unknown {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]");
  } catch {
    return []; // no storage, or unreadable: start empty
  }
}
import type { WorkTarget } from "../../core/assistant.ts";
import { AssistantPanel } from "./components/AssistantPanel.tsx";
import { assistantFetch, useAssistant } from "./hooks/useAssistant.ts";
import { useLiveVoice } from "./hooks/useLiveVoice.ts";
import { ApprovalCard } from "./components/ApprovalCard.tsx";
import { ClarifyCard } from "./components/ClarifyCard.tsx";
import { type Chip, admit, readyFiles, uploadFile } from "./attach.ts";
import { CommandInput } from "./components/CommandInput.tsx";
import { ConfirmCard } from "./components/ConfirmCard.tsx";
import { DecisionLog } from "./components/DecisionLog.tsx";
import { CofounderChat } from "./components/CofounderChat.tsx";
import { Help } from "./components/Help.tsx";
import { LiveView } from "./components/LiveView.tsx";
import { TimerBar } from "./components/TimerBar.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { PaneDivider } from "./components/PaneDivider.tsx";
import { loadPaneHeight, savePaneHeight } from "./layout.ts";
import { useSocket } from "./hooks/useSocket.ts";
import { initialState, reducer } from "./state.ts";
import { detectTransport } from "./transport.ts";

export function App() {
  // The transcript outlives a restart of Jev: kept in this window's own storage (a per-viewer
  // convenience — if storage is unavailable the log just starts empty, as before).
  const [state, dispatch] = useReducer(reducer, initialState, (s) => reducer(s, { type: "restore_log", entries: savedLog() }));
  useEffect(() => {
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(state.entries));
    } catch {
      /* storage full or blocked: the log still works, it just won't survive a restart */
    }
  }, [state.entries]);
  const transport = useMemo(() => detectTransport(), []);
  const assistant = useAssistant(transport);
  const [target, setTarget] = useState<WorkTarget>("local");
  const [quick, setQuick] = useState(false);
  const liveVoice = useLiveVoice(transport, target, state.paused, state.voice?.muted ?? false);
  const send = useSocket(transport, dispatch, (connected) =>
    dispatch({ type: "socket", connected }),
  );

  // Files attached for the next message (📎 or dropped on the panel). A typed or spoken message
  // takes the ready ones with it.
  const [chips, setChips] = useState<Chip[]>([]);
  const chipsRef = useRef<Chip[]>([]);
  chipsRef.current = chips;
  const [dropping, setDropping] = useState(false);
  const attach = useCallback(
    (files: File[]) => {
      const { take, refused } = admit(chipsRef.current.length, files);
      for (const r of refused) dispatch({ type: "status", text: `Not attached: ${r}`, level: "warn" });
      for (const i of take) {
        const file = files[i]!;
        const key = `${Date.now()}-${i}-${file.name}`;
        setChips((cs) => [...cs, { key, name: file.name, state: "uploading" }]);
        void uploadFile(transport.httpUrl("/attachments"), file).then((r) =>
          setChips((cs) => cs.map((c) => (c.key !== key ? c : "error" in r ? { ...c, state: "error", error: r.error } : { ...c, state: "ready", id: r.id, name: r.name }))),
        );
      }
    },
    [transport],
  );
  const removeChip = useCallback((key: string) => setChips((cs) => cs.filter((c) => c.key !== key)), []);
  // Anywhere on the panel takes a file — the top bar too — and a miss never opens the file in place
  // of the panel.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      setDropping(true);
    };
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      setDropping(false);
      attach(Array.from(e.dataTransfer.files));
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDropping(false);
    };
    document.addEventListener("dragover", over);
    document.addEventListener("drop", drop);
    document.addEventListener("dragleave", leave);
    return () => {
      document.removeEventListener("dragover", over);
      document.removeEventListener("drop", drop);
      document.removeEventListener("dragleave", leave);
    };
  }, [attach]);
  const command = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      const files = readyFiles(chipsRef.current);
      if (!trimmed && !files.length) return;
      if ((quick && target === "local") || /^(?:new chat|clear chat)$/i.test(trimmed)) {
        send({ type: "command", text: trimmed, ...(files.length ? { attachments: files } : {}) });
        if (files.length) setChips((cs) => cs.filter((c) => c.state === "uploading"));
      } else {
        void assistantFetch<{ message: string }>(transport, "/command", { text: trimmed, target, requestId: crypto.randomUUID(), ...(files.length ? { attachments: files } : {}) }).then((r) => {
          dispatch({ type: "notice", from: "Jev", text: r.message, level: "ok" });
          if (files.length) setChips((cs) => cs.filter((c) => c.state === "uploading"));
          void assistant.refresh();
        }).catch((e) => dispatch({ type: "status", text: e instanceof Error ? e.message : "Task could not be saved", level: "error" }));
      }
    },
    [send, quick, target, transport, assistant.refresh],
  );
  const paused = state.paused;
  /** Stop everything now: the brain run and the browser step. */
  const stopAll = useCallback(() => {
    liveVoice.hush();
    for (const t of assistant.status?.tasks ?? []) if (["running", "queued", "waiting_for_user"].includes(t.status)) void assistantFetch(transport, `/tasks/${t.id}/control`, { action: "cancel" }).catch(() => {});
    send({ type: "interrupt" });
    send({ type: "command", text: "stop" });
  }, [send, assistant.status, transport, liveVoice.hush]);
  /** Stop the voice only. Also what pressing the microphone does first: the self-hearing gate drops
   *  everything said while she is talking, so without this a push-to-talk press during a long answer
   *  captures nothing at all. */
  const hush = useCallback(() => { liveVoice.hush(); send({ type: "hush" }); }, [send, liveVoice.hush]);
  const setPaused = useCallback((p: boolean) => send({ type: "pause", paused: p }), [send]);
  const setMuted = useCallback((muted: boolean) => send({ type: "voice_mute", muted }), [send]);
  // The live pane's height, dragged by the divider; null = the pane's own proportions.
  const [paneHeight, setPaneHeightState] = useState<number | null>(() => loadPaneHeight(safeStorage()));
  const setPaneHeight = useCallback((h: number | null) => {
    setPaneHeightState(h);
    savePaneHeight(safeStorage(), h);
  }, []);
  const busy = state.status.level === "busy" || state.entries.some((e) => e.brain?.state === "running" || e.brain?.state === "waiting") || !!assistant.status?.tasks.some((t) => t.status === "running" || t.status === "waiting_for_user");
  const desktop = transport.mode === "desktop";
  const talkSubscribe = desktop ? window.jev?.onTalk : undefined;
  useEffect(() => {
    if (!talkSubscribe) return;
    // The key toggles a live conversation; releasing it does not submit a recording.
    return talkSubscribe((cmd) => { if (cmd === "start") void (liveVoice.state === "on" ? liveVoice.stop() : liveVoice.start()); else if (cmd === "abort") void liveVoice.stop(); });
  }, [talkSubscribe, liveVoice.state, liveVoice.start, liveVoice.stop]);

  // Desktop shell: the hotkey shows/focuses the panel; Escape hides it, or cancels while busy
  // (the main process decides which, from the busy flag reported below).
  useEffect(() => {
    if (!desktop) return;
    document.body.classList.add("desktop");
    const bridge = window.jev;
    const offCancel = bridge?.onCancel?.(() => stopAll());
    // "Be quiet" is not "stop" and not "go away": the voice ends, the work continues, the panel stays.
    const offHush = bridge?.onHush?.(() => hush());
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      bridge?.hide?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      offCancel?.();
      offHush?.();
      window.removeEventListener("keydown", onKey);
    };
  }, [desktop, stopAll, hush]);
  useEffect(() => {
    if (desktop) window.jev?.setBusy?.(busy);
  }, [desktop, busy]);
  // Whether the panel is on screen at all. The desktop shell says (its page always reports
  // "visible"); a browser tab has the page's own visibility.
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    if (desktop) return window.jev?.onVisible?.(setOnScreen);
    const sync = () => setOnScreen(document.visibilityState === "visible");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [desktop]);
  // The main process needs this to know that ⌥Space and Escape mean "be quiet" right now.
  useEffect(() => {
    if (desktop) window.jev?.setSpeaking?.(state.speaking || liveVoice.speaking);
  }, [desktop, state.speaking, liveVoice.speaking]);

  return (
    <>
      <TopBar
        jev={state.jev}
        desktop={desktop}
        paused={paused}
        busy={busy}
        speaking={state.speaking || liveVoice.speaking}
        voice={{ on: liveVoice.state === "on", detail: assistant.status?.connections.livekit && assistant.status.connections.openai ? "GPT-Live 1 via LiveKit" : "Live voice needs connection setup", muted: state.voice?.muted }}
        bridge={state.bridge}
        talkingTo={state.talkingTo}
        onStop={stopAll}
        onHush={hush}
        onPause={setPaused}
        onMute={setMuted}
        onHide={desktop ? () => window.jev?.hide?.() : undefined}
        onResize={desktop ? () => void window.jev?.toggleWindowSize?.() : undefined}
      />
      <main
        className={`layout${desktop ? " desktop" : ""}${dropping ? " dropping" : ""}`}
      >
        {dropping && <div className="drop-overlay">Drop to attach</div>}
        <LiveView
          page={state.page}
          jevChrome={state.jevChrome}
          status={state.status}
          connected={state.connected}
          send={send}
          fixedViewport={desktop ? { width: 1024, height: 640 } : undefined}
          browserView={state.browserView}
          tab={state.pane.tab}
          onTab={(tab) => dispatch({ type: "pane_tab", tab })}
          height={desktop ? paneHeight : undefined}
          cofounder={state.cofounder}
          cofounderView={state.cofounderView}
          cofounderFrame={state.cofounderFrame}
          onScreen={onScreen}
        />
        {desktop && <PaneDivider height={paneHeight} onHeight={setPaneHeight} />}
        <aside className="control-pane">
          <AssistantPanel status={assistant.status} error={assistant.error} target={target} onTarget={setTarget} voice={liveVoice} transport={transport} refresh={assistant.refresh} quick={quick} onQuick={setQuick} />
          {state.pane.tab === "cofounder" && state.cofounder && "computer" in state.cofounder && (
            <CofounderChat history={state.cofounderHistory} send={send} visible={onScreen} connected={state.connected} />
          )}
          <CommandInput onSubmit={command} chips={chips} onAttach={attach} onRemove={removeChip} />
          <TimerBar timers={state.timers} />
          {state.pending?.kind === "confirm" && (
            <ConfirmCard
              pending={state.pending}
              onReply={(ok) => {
                send({ type: "confirm_reply", ok });
                dispatch({ type: "dismiss_pending" });
              }}
            />
          )}
          {state.approval && (
            <ApprovalCard
              pending={state.approval}
              onChoose={(choice) => {
                send({ type: "approval_reply", choice });
                dispatch({ type: "dismiss_approval" });
              }}
            />
          )}
          {state.pending?.kind === "clarify" && (
            <ClarifyCard
              pending={state.pending}
              onPick={(elementId) => {
                send({ type: "pick", elementId });
                dispatch({ type: "dismiss_pending" });
              }}
            />
          )}
          <DecisionLog
            entries={state.entries}
            onClear={() => dispatch({ type: "clear_log" })}
            onNewChat={() => command("new chat")}
          />
          <Help />
        </aside>
      </main>
    </>
  );
}

/** localStorage, or nothing: reading the property itself can throw in a locked-down context. */
function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
