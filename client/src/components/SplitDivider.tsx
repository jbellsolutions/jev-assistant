import { useEffect, useRef, useState } from "react";

export function SplitDivider({ workspace = false, onSize, onWidth }: { workspace?: boolean; onSize(v: number | null): void; onWidth?(v: number | null): void }) {
  const [wide, setWide] = useState(() => workspace && window.matchMedia("(min-width: 900px)").matches);
  useEffect(() => { if (!workspace) return; const media = window.matchMedia("(min-width: 900px)"); const sync = () => setWide(media.matches); sync(); media.addEventListener("change", sync); return () => media.removeEventListener("change", sync); }, [workspace]);
  const drag = useRef<{ point: number; value: number } | null>(null);
  const commit = (bar: HTMLElement, delta: number, value: number) => {
    const size = bar.parentElement!.getBoundingClientRect();
    const available = (wide ? size.width : size.height) - 16;
    const next = Math.round(Math.max(wide ? 320 : 150, Math.min(available - (wide ? 320 : 180), value + delta)));
    (wide ? onWidth : onSize)?.(next);
  };
  const current = (bar: HTMLElement) => (wide ? bar.nextElementSibling : bar.previousElementSibling)!.getBoundingClientRect()[wide ? "width" : "height"];
  const reset = () => (wide ? onWidth : onSize)?.(null);
  return <div className={`split-divider ${workspace ? "workspace-divider" : "detail-divider"}`} role="separator" tabIndex={0} aria-label={workspace ? "Resize browser and chat" : "Resize voice and conversation"} aria-orientation={wide ? "vertical" : "horizontal"} title="Drag to resize · double-click to reset"
    onPointerDown={(e) => { drag.current = { point: wide ? e.clientX : e.clientY, value: current(e.currentTarget) }; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); }}
    onPointerMove={(e) => { const d = drag.current; if (d) commit(e.currentTarget, (wide ? d.point - e.clientX : e.clientY - d.point), d.value); }}
    onPointerUp={(e) => { drag.current = null; e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerCancel={() => { drag.current = null; }}
    onDoubleClick={reset} onKeyDown={(e) => { if (e.key === "Home") { reset(); e.preventDefault(); } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) { commit(e.currentTarget, ["ArrowLeft", "ArrowDown"].includes(e.key) ? 24 : -24, current(e.currentTarget)); e.preventDefault(); } }}><span /></div>;
}
