import RFB from "@novnc/novnc/lib/rfb";
import { useEffect, useRef, useState } from "react";
import type { ClientMessage } from "../../../core/protocol.ts";
import { VNC_RETRY_MS, type Zoom, vncBox } from "../layout.ts";
import type { State } from "../state.ts";

/** The co-founder's Orgo desktop, live: noVNC straight to Orgo's socket, clickable and typeable.
 *  A dropped link is retried on its own (fresh address and password each time); only after that
 *  does it fall back to a still picture from Orgo's API — under a banner that says clicks no
 *  longer reach it. The VNC password lives only in this component's memory. */
export function CofounderView({ view, frame, send, zoom }: { view: State["cofounderView"]; frame: State["cofounderFrame"]; send: (msg: ClientMessage) => void; zoom: Zoom }) {
  const box = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState("Connecting to the co-founder's computer…");
  const [still, setStill] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [fb, setFb] = useState<{ width: number; height: number } | null>(null);
  const retries = useRef(0);
  const live = useRef<RFB | null>(null);

  // Every attempt (the tab opening, an automatic retry, Reconnect): a fresh address and password.
  useEffect(() => {
    setStill(false);
    setNote(retries.current ? `Reconnecting to the co-founder's computer (try ${retries.current} of ${VNC_RETRY_MS.length})…` : "Connecting to the co-founder's computer…");
    send({ type: "cofounder_view" });
  }, [send, attempt]);

  useEffect(() => {
    if (!view || "error" in view || !box.current) return;
    let rfb: RFB | null = null;
    let closing = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const lost = (why: string) => {
      if (closing) return;
      const wait = VNC_RETRY_MS[retries.current];
      if (wait !== undefined) {
        retries.current++;
        setNote("The live desktop dropped — reconnecting…");
        retry = setTimeout(() => setAttempt((n) => n + 1), wait);
        return;
      }
      setStill(true);
      setNote(why);
    };
    try {
      rfb = new RFB(box.current, view.wsUrl, { credentials: { password: view.password } });
      rfb.scaleViewport = true; // always noVNC's own scaling: the box size is what zoom changes
      live.current = rfb;
      rfb.addEventListener("connect", () => {
        retries.current = 0;
        setNote("");
        const canvas = box.current?.querySelector("canvas");
        if (canvas?.width && canvas.height) setFb({ width: canvas.width, height: canvas.height });
      });
      rfb.addEventListener("credentialsrequired", () => rfb?.sendCredentials({ password: view.password }));
      rfb.addEventListener("disconnect", () => lost("The live desktop is gone after 3 tries."));
    } catch (err) {
      lost(`Couldn't open the live desktop (${err instanceof Error ? err.message : String(err)}).`);
    }
    return () => {
      closing = true;
      clearTimeout(retry);
      if (live.current === rfb) live.current = null;
      rfb?.disconnect();
    };
  }, [view]);

  useEffect(() => {
    if (!still) return;
    send({ type: "cofounder_frame" });
    const t = setInterval(() => send({ type: "cofounder_frame" }), 2000);
    return () => clearInterval(t);
  }, [still, send]);

  const reconnect = () => {
    retries.current = 0;
    setAttempt((n) => n + 1);
  };

  // Every zoom step re-scales the desktop to its new box. noVNC's own resize observer missed the
  // way back to Fit (measured in the installed app: the box shrank to 414px, the canvas stayed at
  // 1024), and setting scaleViewport always re-scales — after layout, so it reads the new size.
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => {
      if (live.current) live.current.scaleViewport = true;
    }));
    return () => cancelAnimationFrame(id);
  }, [zoom, fb]);

  if (view && "error" in view) {
    return (
      <div className="overlay">
        {view.error}
        <button type="button" className="reconnect" onClick={reconnect}>
          Try again
        </button>
      </div>
    );
  }
  const sized = vncBox(zoom, fb);
  return (
    <div className={`cofounder-view${sized ? " native" : ""}${still ? " still" : ""}`}>
      {still && (
        <div className="cofounder-banner" role="alert">
          <span>Live view lost — this is a picture, refreshed every 2 seconds. Clicks and typing don't reach it. {note}</span>
          <button type="button" className="reconnect" onClick={reconnect}>
            Reconnect
          </button>
        </div>
      )}
      {still ? frame?.jpegBase64 ? <img src={`data:image/jpeg;base64,${frame.jpegBase64}`} alt="The co-founder's desktop (a still picture)" draggable={false} /> : null : <div ref={box} className="vnc" style={sized ?? undefined} />}
      {note && !still && <div className="cofounder-note">{note}</div>}
    </div>
  );
}
