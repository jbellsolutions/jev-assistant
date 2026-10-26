import { useEffect, useRef, useState } from "react";
import type { ClientMessage } from "../../../core/protocol.ts";
import type { State } from "../state.ts";

/** How often the chat is re-read from the Studio while it is on screen. Each read is one Orgo
 *  shell call on the co-founder's computer, so it only happens while someone is looking. */
export const COFOUNDER_POLL_MS = 5_000;

const DONE = new Set(["complete", "error", "cancelled", "needs_review"]);

/** the user's conversation with the co-founder, and a box to write to it — chat as well as voice.
 *  The Studio keeps one ongoing session with the co-founder, so this is the same conversation the
 *  Studio app shows. */
export function CofounderChat({ history, send, visible, connected }: { history: State["cofounderHistory"]; send: (msg: ClientMessage) => void; visible: boolean; connected: boolean }) {
  const [draft, setDraft] = useState("");
  const [sentAt, setSentAt] = useState(0);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!visible || !connected) return;
    send({ type: "cofounder_history" });
    const t = setInterval(() => send({ type: "cofounder_history" }), COFOUNDER_POLL_MS);
    return () => clearInterval(t);
  }, [visible, connected, send, sentAt]);

  const exchanges = history && "exchanges" in history ? [...history.exchanges].reverse() : [];
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [exchanges.length, exchanges.at(-1)?.state]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    send({ type: "cofounder_say", text });
    setDraft("");
    setSentAt(Date.now()); // re-read straight away so the new message shows
  };

  return (
    <section className="cofounder-chat" aria-label="Chat with the co-founder">
      <div className="log-head">
        <span>Co-founder chat</span>
        {history && "error" in history && <span className="muted" title={history.error}>can't read the Studio</span>}
      </div>
      <ol ref={listRef} className="cofounder-msgs">
        {!history && <li className="muted">Loading the conversation…</li>}
        {history && "error" in history && <li className="muted">{history.error}</li>}
        {history && "exchanges" in history && !exchanges.length && <li className="muted">No messages yet.</li>}
        {exchanges.map((d) => (
          <li key={d.id}>
            <div className="msg you">{d.body}</div>
            {d.result ? <div className={`msg them${d.state === "error" ? " error" : ""}`}>{d.result}</div> : <div className="msg them muted">{DONE.has(d.state) ? d.state : "working…"}</div>}
          </li>
        ))}
      </ol>
      <form
        className="cofounder-say"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          value={draft}
          placeholder="Write to the co-founder…"
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
