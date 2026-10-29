import type { useLiveVoice } from "../hooks/useLiveVoice.ts";
export function VoiceInput({ voice }: { voice: ReturnType<typeof useLiveVoice> }) {
  return <div className="voice-input">
    <label>Microphone <select aria-label="Microphone" value={voice.inputDevice} disabled={voice.state === "connecting" || voice.inputBusy} onChange={(e) => void voice.changeInput(e.target.value)}>
      <option value="default">System default</option>
      {voice.devices.filter((d) => d.deviceId && d.deviceId !== "default").map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
    </select></label>
    {voice.state === "on" && <><meter aria-label="Microphone input level" min={0} max={1} value={voice.inputLevel} /><small role="status">{voice.inputStatus}</small><button type="button" disabled={voice.inputBusy} onClick={() => void voice.retryMicrophone()}>Retry microphone</button></>}
  </div>;
}
