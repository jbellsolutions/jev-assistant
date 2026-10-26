import { useLayoutEffect, useRef, useState } from "react";
import { type Chip, keyAction } from "../attach.ts";

/** The chat box: grows with what's typed, Enter sends, Shift+Enter adds a line, 📎 attaches. */
export function CommandInput({ onSubmit, chips = [], onAttach, onRemove }: { onSubmit: (text: string) => void; chips?: Chip[]; onAttach?: (files: File[]) => void; onRemove?: (key: string) => void }) {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const uploading = chips.some((c) => c.state === "uploading");
  const canSend = !uploading && (text.trim() !== "" || chips.some((c) => c.state === "ready"));

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const send = () => {
    if (!canSend) return;
    onSubmit(text);
    setText("");
  };

  return (
    <form
      className="text-form"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {chips.length > 0 && (
        <div className="chips" aria-label="Attached files">
          {chips.map((c) => (
            <span key={c.key} className={`chip ${c.state}`} title={c.error ?? c.name}>
              📎 {c.name}
              {c.state === "uploading" && " …"}
              {c.state === "error" && ` — ${c.error}`}
              {onRemove && (
                <button type="button" className="chip-x" aria-label={`Remove ${c.name}`} onClick={() => onRemove(c.key)}>
                  ✕
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="text-row">
        {onAttach && (
          <>
            <button type="button" className="attach" aria-label="Attach a file" title="Attach a file (or drop it on the panel)" onClick={() => picker.current?.click()}>
              📎
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) onAttach(files);
                e.target.value = "";
              }}
            />
          </>
        )}
        <textarea
          id="text-input"
          ref={box}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (keyAction(e.nativeEvent) === "send") {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Type to Jev — Shift+Enter for a new line, 📎 or drop a file to attach a charter or plan"
          aria-label="Type a message"
        />
        <button type="submit" disabled={!canSend}>
          {uploading ? "…" : "Send"}
        </button>
      </div>
    </form>
  );
}
