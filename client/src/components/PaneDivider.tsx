import { useRef } from "react";
import { clampPane } from "../layout.ts";

/** The bar between the live pane and the text box: drag to give either more room, double-click to
 *  go back to the default. The size is remembered for this viewer. */
export function PaneDivider({ height, onHeight }: { height: number | null; onHeight: (h: number | null) => void }) {
  const drag = useRef<{ startY: number; startH: number } | null>(null);

  const paneEl = (bar: HTMLElement) => bar.previousElementSibling as HTMLElement | null;
  // The room both halves share: the layout's height, less the bar itself.
  const available = (bar: HTMLElement) => (bar.parentElement?.getBoundingClientRect().height ?? window.innerHeight) - bar.getBoundingClientRect().height;

  return (
    <div
      className="pane-divider"
      role="separator"
      aria-orientation="horizontal"
      aria-valuenow={height ?? undefined}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        const bar = e.currentTarget;
        const pane = paneEl(bar);
        if (!pane) return;
        drag.current = { startY: e.clientY, startH: pane.getBoundingClientRect().height };
        bar.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        onHeight(clampPane(d.startH + (e.clientY - d.startY), available(e.currentTarget)));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onDoubleClick={() => onHeight(null)}
    >
      <span />
    </div>
  );
}
