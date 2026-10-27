/** The existing LiveKit speaker events drive this visual. No audio capture/analyser or JS loop. */
export function VoiceOrb({ state, speaking, userSpeaking, visible = true }: { state: "off" | "connecting" | "on"; speaking: boolean; userSpeaking: boolean; visible?: boolean }) {
  const mode = state === "off" ? "idle" : state === "connecting" ? "connecting" : speaking ? "speaking" : userSpeaking ? "hearing" : "listening";
  const label = mode === "idle" ? "Ready to talk" : mode === "connecting" ? "Connecting live voice" : mode === "speaking" ? "Jarvis is speaking" : mode === "hearing" ? "Hearing you" : "Listening";
  return <div className={`voice-orb-wrap ${mode}${visible ? "" : " paused"}`} role="img" aria-label={label} data-mode={mode}>
    <div className="voice-orb-ring" aria-hidden="true" /><div className="voice-orb" aria-hidden="true"><span /></div>
    <span className="voice-orb-label">{label}</span>
  </div>;
}
