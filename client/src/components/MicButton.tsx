import { useEffect, useRef } from "react";
import type { ListenSettings, SttMode } from "../../../core/protocol.ts";
import type { StreamingOptions, VoiceAvailability } from "../hooks/useStreamingTranscription.ts";
import { useStreamingTranscription } from "../hooks/useStreamingTranscription.ts";

/** How many times to reopen a microphone that keeps closing before leaving it to the user. Roughly a
 *  minute of backoff, after which the error note is the honest answer rather than another attempt. */
const RETRIES = 6;

const NOTES: Record<VoiceAvailability, string | null> = {
  unsupported: "This browser cannot capture voice here. Use Chrome, Edge, or the desktop app; the text box below still works.",
  insecure: "Microphone access requires a secure context. Open this page via http://localhost or https.",
  "no-mic": "No microphone found.",
  ok: null,
};

export function MicButton({
  transport,
  onUtterance,
  paused = false,
  listen = { mode: "push", wakeAvailable: false },
  onMode,
  onOpen,
  onTalk,
}: {
  transport: StreamingOptions["transport"];
  onUtterance: (text: string) => void;
  paused?: boolean;
  listen?: ListenSettings;
  onMode?: (mode: SttMode) => void;
  /** Called just before the microphone opens, to stop Jev talking over the answer being given. */
  onOpen?: () => void;
  /** The talk key (desktop): subscribes to start / stop / abort. */
  onTalk?: (cb: (cmd: "start" | "stop" | "abort") => void) => () => void;
}) {
  const wake = listen.mode === "wake" && listen.wakeAvailable;
  const speech = useStreamingTranscription({ transport, onUtterance, ...(wake ? { mode: "wake" as const } : {}) });
  // The talk key is push-to-talk in both modes. In wake mode the standing stream is fixed to
  // listening for "Hey Jev", so the key gets its own short push stream (billed only while held).
  const keyed = useStreamingTranscription({ transport, onUtterance });
  const talk = wake ? keyed : speech;
  const talkRef = useRef(talk);
  talkRef.current = talk;
  useEffect(() => {
    if (!onTalk) return;
    return onTalk((cmd) => {
      const t = talkRef.current;
      if (cmd === "start") {
        if (paused) return;
        onOpen?.();
        t.start();
      } else if (cmd === "stop") t.stop();
      else t.close();
    });
  }, [onTalk, onOpen, paused]);
  const disabled = speech.availability !== "ok" || paused;

  // Always-on has to mean always on: in wake mode the microphone opens itself, because a standing
  // ear that needs a click first is just the button with extra steps. Switching mode tears the old
  // stream down (its `mode` was fixed when `start` was sent) and the next tick opens the new one.
  const want = wake && !disabled;
  const listening = speech.listening;
  const { start, close } = speech;
  const mode = useRef(listen.mode);
  /** Consecutive failed opens. A dying helper would otherwise be respawned as fast as it dies: the
   *  capture reports `closed`, `listening` goes false, and this effect immediately opens another. */
  const attempts = useRef(0);
  useEffect(() => {
    const changed = mode.current !== listen.mode;
    mode.current = listen.mode;
    // Close, not stop: stop() keeps the capture alive for 1.2s so the server can flush a last
    // utterance, and while it lives start() returns early — so switching mode mid-listen would wedge
    // with the microphone shut and nothing reopening it. There is nothing to flush on a mode change.
    if (changed) attempts.current = 0;
    if (changed && listening) return close();
    // Pause has to release the microphone, not merely be ignored: `want` goes false and the button
    // is not clickable in wake mode, so this is the only thing that can hand the mic back.
    if (!want && listening && wake) return close();
    if (listening) {
      attempts.current = 0;
      return;
    }
    if (!want || attempts.current > RETRIES) return;
    const delay = attempts.current === 0 ? 0 : Math.min(30_000, 500 * 2 ** attempts.current);
    attempts.current++;
    const t = setTimeout(start, delay);
    return () => clearTimeout(t);
  }, [want, wake, listening, listen.mode, speech.error, start, close]);

  const label =
    speech.availability === "unsupported"
      ? "Voice not supported here"
      : speech.availability === "insecure"
        ? "Voice needs HTTPS or localhost"
        : paused
          ? "Paused — resume to talk to Jev"
          : wake && keyed.listening
            ? "Listening — let go of the talk key to send"
            : wake
            ? speech.woken
              ? "Yes? — go ahead"
              : speech.listening
                ? 'Standing by — say "Hey Jev"'
                : "Opening the microphone…"
            : speech.listening
              ? "Listening — tap to stop"
              : "Tap to talk to Jev";
  const note = NOTES[speech.availability] ?? speech.error;

  return (
    <>
      <div className="mic-block">
        <button
          id="mic"
          type="button"
          className={`mic${wake ? " mic-wake" : ""}${speech.woken ? " mic-woken" : ""}`}
          aria-pressed={speech.listening}
          title={wake ? (speech.listening ? "Listening for “Hey Jev”" : "Starting") : speech.listening ? "Stop listening" : "Start listening"}
          disabled={disabled || wake}
          onClick={() => {
            if (!speech.listening) onOpen?.();
            speech.toggle();
          }}
        >
          <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
            <path fill="currentColor" d="M12 15a4 4 0 0 0 4-4V6a4 4 0 1 0-8 0v5a4 4 0 0 0 4 4Zm6-4a1 1 0 1 1 2 0 8 8 0 0 1-7 7.94V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2.06A8 8 0 0 1 4 11a1 1 0 1 1 2 0 6 6 0 0 0 12 0Z" />
          </svg>
        </button>
        <div className="mic-text">
          <div className="mic-label">{label}</div>
          <div className="interim">{(wake && keyed.listening ? keyed.interim : speech.interim) || " "}</div>
        </div>
        {onMode && listen.wakeAvailable && (
          <div className="listen-switch" role="group" aria-label="How Jev listens">
            {(["push", "wake"] as const).map((m) => (
              <button key={m} type="button" className={listen.mode === m ? "on" : ""} aria-pressed={listen.mode === m} onClick={() => onMode(m)} title={m === "push" ? "Press the mic to talk" : 'Leave the microphone open and say "Hey Jev"'}>
                {m === "push" ? "Button" : "Hey Jev"}
              </button>
            ))}
          </div>
        )}
      </div>
      {note && <p className="note">{note}</p>}
    </>
  );
}
