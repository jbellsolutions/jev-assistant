import { useEffect, useState } from "react";

/** How often to check that Jarvis's browser is still there (browser-box can be stopped under us). */
const PROBE_MS = 10_000;

/** Jarvis's own browser, live and clickable: browser-box's session player in a frame. It is the same
 *  browser the brain's browser_box tool drives, so the user watches it work — and can click, type or
 *  sign in himself, once, for a site Jarvis should reuse. */
/** `zoom` shrinks or enlarges the whole player: the frame is laid out 1/zoom as big and scaled back,
 *  so the page inside still fills the box and stays clickable. */
export function BrowserView({ url, zoom = 1 }: { url: string; zoom?: number }) {
  const [up, setUp] = useState<boolean | null>(null);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try {
        // no-cors: we only need to know something answers; a refused connection rejects
        await fetch(url, { mode: "no-cors", cache: "no-store" });
        if (alive) setUp((was) => {
          if (was === false) setEpoch((n) => n + 1); // it came back: reload the frame
          return true;
        });
      } catch {
        if (alive) setUp(false);
      }
    };
    void probe();
    const t = setInterval(probe, PROBE_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [url]);

  if (up === false) return <div className="overlay">Jarvis's browser isn't running (browser-box is down).</div>;
  const style = zoom === 1 ? undefined : { width: `${100 / zoom}%`, height: `${100 / zoom}%`, transform: `scale(${zoom})`, transformOrigin: "0 0" };
  return <iframe key={epoch} className="browser-view" src={url} title="Jarvis's browser — live" allow="clipboard-read; clipboard-write" style={style} />;
}
