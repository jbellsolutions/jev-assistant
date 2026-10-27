import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage } from "../../../core/protocol.ts";
import { type Zoom, freshness, frameFraction, keystroke, stepZoom } from "../layout.ts";
import type { PaneTab, State } from "../state.ts";
import { CofounderView } from "./CofounderView.tsx";
import { CloudBrowser } from "./CloudBrowser.tsx";
import type { Transport } from "../transport.ts";

interface Props {
  transport: Transport;
  cloudRunning?: boolean;
  page: State["page"];
  /** Where Jarvis is working in its own minimized Chrome window (no picture exists of it). */
  jevChrome?: State["jevChrome"];
  status: State["status"];
  connected: boolean;
  send: (msg: ClientMessage) => void;
  /** Keep the real viewport at this size and scale the frame to fit (small panels). */
  fixedViewport?: { width: number; height: number };
  /** Jarvis's own browser, live (null: only the screen view exists). */
  browserView?: string | null;
  tab?: PaneTab;
  onTab?: (tab: PaneTab) => void;
  /** The divider's height for the pane: a number, or null for the default share. Undefined (the web
   *  preview) keeps the old fixed proportions. */
  height?: number | null;
  cofounder?: State["cofounder"];
  cofounderView?: State["cofounderView"];
  cofounderFrame?: State["cofounderFrame"];
  /** False while the panel window is hidden: nobody can see the picture, so none is taken. */
  onScreen?: boolean;
}

/** The streamed view of the controlled browser. Reports its own pixel size so the server
 *  sizes the real viewport to match (no CSS scaling); clicks are forwarded as fractions. */
function useNow(ms: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
  return now;
}

export function LiveView({ transport, cloudRunning = false, page, jevChrome = null, status, connected, send, fixedViewport, browserView = null, tab = "screen", onTab, height, cofounder = null, cofounderView = null, cofounderFrame = null, onScreen = true }: Props) {
  const sized = height !== undefined;
  const showBrowser = tab === "browser";
  const showCofounder = !!cofounder && tab === "cofounder";
  const showScreen = !showBrowser && !showCofounder;
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // Each view keeps its own zoom: shrinking Jarvis's browser shouldn't shrink the picture of your screen.
  const [zooms, setZooms] = useState<Record<PaneTab, Zoom>>({ browser: "fit", screen: "fit", cofounder: "fit" });
  const view: PaneTab = showBrowser ? "browser" : showCofounder ? "cofounder" : "screen";
  const zoom = zooms[view];
  const setZoom = (z: Zoom) => setZooms((all) => ({ ...all, [view]: z }));
  const [typing, setTyping] = useState(false);
  const now = useNow(1000, onScreen);
  const fresh = freshness(page, now);

  // Your windows are pictured only while this tab is showing: opening it asks for a picture now
  // (the server sends one straight away), leaving it or hiding the panel stops the captures.
  const watching = showScreen && onScreen;
  useEffect(() => {
    if (connected) send({ type: "frames", on: watching });
  }, [connected, watching, send]);

  // Typed characters are batched briefly, so a word is one message rather than one per letter.
  const buffered = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useCallback(() => {
    clearTimeout(flushTimer.current);
    const text = buffered.current;
    buffered.current = "";
    if (text) send({ type: "type_at", text });
  }, [send]);
  useEffect(() => () => clearTimeout(flushTimer.current), []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!showScreen || !page.frame) return;
    const k = keystroke(e);
    if (!k) return;
    e.preventDefault();
    e.stopPropagation(); // Escape here is for the pictured window, not "hide the panel"
    if ("text" in k) {
      buffered.current += k.text;
      clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(flush, 150);
    } else {
      flush();
      send({ type: "key_at", key: k.key });
    }
  };

  useEffect(() => {
    const box = boxRef.current;
    if (!box || !connected) return;
    if (fixedViewport) {
      send({ type: "viewport", ...fixedViewport });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      const r = box.getBoundingClientRect();
      if (r.width >= 100 && r.height >= 100) send({ type: "viewport", width: Math.round(r.width), height: Math.round(r.height) });
    };
    report();
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(report, 300);
    });
    ro.observe(box);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
  }, [connected, send, fixedViewport]);

  const onClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const r = img.getBoundingClientRect();
    const at = frameFraction({ x: e.clientX, y: e.clientY }, r, { width: img.naturalWidth, height: img.naturalHeight });
    boxRef.current?.focus({ preventScroll: true }); // so typing goes to the picture next
    if (!at) return;
    flush();
    send({ type: "click_at", ...at });
  };

  const zoomed = zoom !== "fit";
  const imgStyle: React.CSSProperties | undefined = zoomed && imgRef.current?.naturalWidth ? { width: imgRef.current.naturalWidth * zoom, height: "auto", maxWidth: "none" } : undefined;

  return (
    <section className={`browser-pane${sized ? " sized" : ""}`} style={height ? { height } : undefined}>
      <div className="urlbar">
        {onTab && (
          <div className="pane-tabs" role="tablist" aria-label="What the big pane shows">
            <button type="button" role="tab" aria-selected={tab === "browser"} className={tab === "browser" ? "on" : ""} onClick={() => onTab("browser")} title="Jarvis's own browser — live; click and type in it">
              Jarvis's browser
            </button>
            <button type="button" role="tab" aria-selected={showScreen} className={showScreen ? "on" : ""} onClick={() => onTab("screen")} title="The app Jarvis is working in, or the one in front of you — click and type in it">
              Your screen
            </button>
            {cofounder && (
              <button type="button" role="tab" aria-selected={showCofounder} className={showCofounder ? "on" : ""} onClick={() => onTab("cofounder")} title={"computer" in cofounder ? "The co-founder's own Orgo computer, live — click and type in it" : cofounder.off}>
                Co-founder's computer
              </button>
            )}
          </div>
        )}
        {showScreen && (
          <>
            <span id="page-live" className={`live-badge ${fresh.live ? "on" : "off"}`} title={fresh.text}>
              {fresh.live ? "● Live" : fresh.text}
            </span>
            <span id="page-title" className="title">{page.title || "—"}</span>
            <span id="page-url" className="url">{page.url}</span>
          </>
        )}
        {!showBrowser && <div className="zoom" role="group" aria-label="Zoom">
          <button type="button" title="Smaller" onClick={() => setZoom(stepZoom(zoom, -1))}>
            −
          </button>
          <button type="button" className={zoomed ? "" : "on"} title="Fit the box" onClick={() => setZoom("fit")}>
            {zoomed ? `${Math.round((zoom as number) * 100)}%` : "Fit"}
          </button>
          <button type="button" title="Bigger" onClick={() => setZoom(stepZoom(zoom, 1))}>
            +
          </button>
        </div>}
      </div>
      <div
        className={`screen${fixedViewport && !sized ? " scaled" : ""}${zoomed ? " zoomed" : ""}${typing ? " typing" : ""}`}
        ref={boxRef}
        style={fixedViewport && !sized ? { aspectRatio: `${fixedViewport.width} / ${fixedViewport.height}` } : undefined}
        tabIndex={showScreen && page.frame ? 0 : undefined}
        onKeyDown={onKeyDown}
        onFocus={() => setTyping(showScreen && !!page.frame)}
        onBlur={() => {
          flush();
          setTyping(false);
        }}
      >
        {showBrowser ? (
          <CloudBrowser transport={transport} visible={onScreen} running={cloudRunning} />
        ) : showCofounder ? (
          "computer" in cofounder! ? <CofounderView view={cofounderView} frame={cofounderFrame} send={send} zoom={zoom} /> : <div className="overlay">The co-founder's computer isn't connected yet. {cofounder!.off}.</div>
        ) : page.frame ? (
          <img ref={imgRef} id="screen" src={page.frame} alt="Live view of the window Jarvis is showing — click and type here" draggable={false} onClick={onClick} style={imgStyle} />
        ) : (
          <div className="overlay">{fresh.text === "Waiting for a picture" ? "Waiting for the screen…" : fresh.text}</div>
        )}
        {typing && <div className="typing-hint">Typing goes to {page.title || "this window"} · Esc key is sent too · click outside to stop</div>}
      </div>
      {jevChrome && (
        <div className="jev-chrome-strip" title="Jarvis works in its own minimized Chrome window — same logins, never on your screen">
          Jarvis is working in its own Chrome · {jevChrome.action}
          {jevChrome.url ? ` · ${jevChrome.url}` : ""}
        </div>
      )}
      <div id="status" className={`status ${status.level}`}>{status.text}</div>
    </section>
  );
}
