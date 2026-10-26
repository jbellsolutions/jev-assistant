import { useEffect, useState } from "react";

/** Running timers, counting down.
 *
 *  The server sends an absolute `dueAt` and nothing else — it never ticks. This component owns the
 *  one interval, which means a timer's display cannot drift from the alarm that will actually fire,
 *  and a Mac that was asleep shows the right number the moment the panel wakes up. */
export function TimerBar({ timers }: { timers: Array<{ id: number; dueAt: number; label: string | null }> }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!timers.length) return;
    const handle = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(handle);
  }, [timers.length]);

  if (!timers.length) return null;
  return (
    <div className="timers" aria-live="polite">
      {timers.map((t) => {
        const left = Math.max(0, Math.round((t.dueAt - now) / 1000));
        const mins = Math.floor(left / 60);
        const secs = left % 60;
        return (
          <span className="timer" key={t.id}>
            <span className="timer-clock">
              {mins}:{String(secs).padStart(2, "0")}
            </span>
            {t.label ? <span className="timer-label">{t.label}</span> : null}
          </span>
        );
      })}
    </div>
  );
}
