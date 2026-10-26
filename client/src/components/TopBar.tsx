import type { State } from "../state.ts";

export function TopBar({
  jev,
  desktop = false,
  paused = false,
  busy = false,
  speaking = false,
  voice = null,
  bridge = null,
  talkingTo = "jev",
  onTalkTo,
  onStop,
  onPause,
  onHide,
  onResize,
  onHush,
  onMute,
}: {
  jev: State["jev"];
  desktop?: boolean;
  paused?: boolean;
  /** Something is running or being said: show the stop button. */
  busy?: boolean;
  /** Jev's voice is playing. */
  speaking?: boolean;
  /** Whether Jev has a voice at all, and which. Shown because silence and a missing key looked
   *  identical from the panel — the only place that said so was stdout. */
  voice?: State["voice"];
  /** The connected Chrome extension; a pill appears only when it is an older build. */
  bridge?: State["bridge"];
  /** Who the user's words go to; the pill switches it (only shown when the co-founder is connected). */
  talkingTo?: State["talkingTo"];
  onTalkTo?: (to: State["talkingTo"]) => void;
  onStop?: () => void;
  /** Stop the voice without stopping the work. */
  onHush?: () => void;
  onPause?: (paused: boolean) => void;
  onHide?: () => void;
  onResize?: () => void;
  /** Mute or unmute her voice; the pill becomes the switch. */
  onMute?: (muted: boolean) => void;
}) {
  const label = !jev ? "connecting…" : jev.enabled ? `Jev · ${jev.model}` : "Local controls";
  const tone = !jev ? "" : jev.enabled ? "jev" : "heuristic";
  return (
    <header className={`topbar${paused ? " paused" : ""}`}>
      <div className="brand">
        <span className="dot" />
        <strong>{desktop ? "Jev" : "Jev Voice Browser"}</strong>
        <span className="sub">{paused ? "paused" : desktop ? "⌥Space" : "voice · tasks · your computer"}</span>
      </div>
      {onHush && speaking && !paused && (
        <button type="button" className="hush-btn" title="Stop talking (Esc or ⌥Space does this too); whatever she is doing carries on" onClick={onHush}>
          <span className="bars" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          Speaking
        </button>
      )}
      {onStop && busy && !paused && (
        <button type="button" className="stop-btn" title="Stop everything: the current step and the brain" onClick={onStop}>
          ■ Stop
        </button>
      )}
      {onPause && (
        <button type="button" className={`pause-btn${paused ? " on" : ""}`} title={paused ? "Switch Jev back on" : "Switch Jev off: it stops acting until resumed"} onClick={() => onPause(!paused)}>
          {paused ? "⏻ Resume" : "⏻ Pause"}
        </button>
      )}
      {voice &&
        (voice.on && onMute ? (
          <button type="button" className={`pill voice on${voice.muted ? " muted" : ""}`} title={`${voiceTitle(voice)}\n${voice.muted ? "Muted — click (or say \"voice on\") to hear her again" : "Click (or say \"mute yourself\") to mute her voice"}`} onClick={() => onMute(!voice.muted)} aria-pressed={!!voice.muted}>
            {voicePill(voice)}
          </button>
        ) : (
          <div className={`pill voice${voice.on ? " on" : ""}`} title={voiceTitle(voice)}>
            {voicePill(voice)}
          </div>
        ))}
      {onTalkTo && (
        <button
          type="button"
          className={`pill talk-to${talkingTo === "cofounder" ? " cofounder" : ""}`}
          title={talkingTo === "cofounder" ? 'What you say goes straight to the co-founder. Click (or say "back to Jev") to talk to Jev.' : 'Click (or say "talk to the co-founder") to talk to the co-founder directly.'}
          onClick={() => onTalkTo(talkingTo === "cofounder" ? "jev" : "cofounder")}
          aria-pressed={talkingTo === "cofounder"}
        >
          Talking to: {talkingTo === "cofounder" ? "Co-founder" : "Jev"}
        </button>
      )}
      {bridgeWarning(bridge) && (
        <div className="pill bridge-old" title={bridgeWarning(bridge)!}>
          ⚠ Chrome extension out of date
        </div>
      )}
      <div id="jev-pill" className={`pill ${tone}`}>{label}</div>
      {onResize && <button type="button" className="window-size-btn" onClick={onResize} aria-label="Toggle larger window" title="Switch between a large workspace and compact panel">↗ Resize</button>}
      {onHide && (
        <button type="button" className="hide-btn" title="Hide (Esc)" onClick={onHide} aria-label="Hide panel">
          ×
        </button>
      )}
    </header>
  );
}

/** The pill's text: muted says so first, since that is why she is quiet. */
/** Why the connected Chrome extension needs a reload, or null when it's current (or absent). */
export function bridgeWarning(bridge: State["bridge"]): string | null {
  if (!bridge || bridge.protocol >= bridge.current) return null;
  return `Chrome is running an older Jev bridge (v${bridge.protocol}; Jev speaks v${bridge.current}), so working in the background is off. In chrome://extensions, press Reload on "Jev bridge" — it loads from jev/dist/extension.`;
}

export function voicePill(voice: NonNullable<State["voice"]>): string {
  if (!voice.on && /GPT-Live|Live voice/.test(voice.detail)) return "◉ Live voice idle";
  if (!voice.on) return "🔇 no voice";
  if (voice.muted) return "🔇 muted";
  return `🔊 ${voice.detail.split(" ")[0]}${voice.device ? ` → ${voice.device}` : ""}`;
}

/** The pill's tooltip: which voice, and where it comes out. Jev follows the Mac's output setting, so
 *  "no sound in my headset" is answered by the device named here. */
export function voiceTitle(voice: NonNullable<State["voice"]>): string {
  if (!voice.device) return voice.detail;
  return `${voice.detail}\nPlaying through: ${voice.device} (change it in System Settings → Sound)`;
}
