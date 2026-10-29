import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import type { WorkTarget } from "../../../core/assistant.ts";
import type { Transport } from "../transport.ts";
import { assistantFetch } from "./useAssistant.ts";
import { type VoiceConnection, voiceFailureMessage } from "../../../core/voice-connection.ts";

export function useLiveVoice(transport: Transport, target: WorkTarget, paused: boolean, muted: boolean) {
  const [state, setState] = useState<"off" | "connecting" | "on">("off");
  const [error, setError] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [needsAudio, setNeedsAudio] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [inputDevice, setInputDevice] = useState(() => { try { return localStorage.getItem("jarvis-microphone") || "default"; } catch { return "default"; } });
  const [inputLevel, setInputLevel] = useState(0);
  const [inputStatus, setInputStatus] = useState("");
  const [inputBusy, setInputBusy] = useState(false);
  const retrying = useRef(false);
  const meterCleanup = useRef<(() => void) | null>(null);
  const meterContext = useRef<AudioContext | null>(null);
  const refreshDevices = useCallback(async () => {
    try { setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput")); } catch {}
  }, []);
  const watchMicrophone = useCallback(async (room: Room, media: MediaStreamTrack) => {
    meterCleanup.current?.();
    if (media.readyState !== "live" || !media.enabled) throw new Error("The microphone is not sending audio. Choose an input and retry the microphone.");
    const context = new AudioContext(); meterContext.current = context;
    let timer: ReturnType<typeof setInterval> | undefined;
    const source = context.createMediaStreamSource(new MediaStream([media]));
    const analyser = context.createAnalyser(); analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const openedAt = Date.now(); let heardSound = false;
    const ended = () => { if (roomRef.current === room) { setInputLevel(0); setInputStatus("Microphone disconnected. Choose an input and retry the microphone."); } };
    media.addEventListener("ended", ended);
    meterCleanup.current = () => { if (meterContext.current === context) meterContext.current = null; clearInterval(timer); media.removeEventListener("ended", ended); source.disconnect(); void context.close().catch(() => {}); };
    // Safari can defer resume until another gesture. Capture must not wait for the meter.
    void context.resume().catch(() => {});
    if (roomRef.current !== room) return;
    setInputStatus("Speak to test your microphone.");
    timer = setInterval(() => {
      if (roomRef.current !== room) return;
      if (context.state !== "running") { setInputStatus("Tap to enable sound to check microphone input."); setNeedsAudio(true); return; }
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      setInputLevel(Math.min(1, rms * 8));
      if (rms > 0.003) { heardSound = true; setInputStatus("Microphone is receiving sound."); }
      else if (media.readyState !== "live" || media.muted || !media.enabled) setInputStatus("Microphone is unavailable or muted. Choose an input and retry the microphone.");
      else if (!heardSound && Date.now() - openedAt > 8000) setInputStatus("No microphone sound detected. Check your input or retry the microphone.");
    }, 100);
    await refreshDevices();
  }, [refreshDevices]);
  const [transcripts, setTranscripts] = useState<Array<{ id: string; who: string; text: string }>>([]);
  const roomRef = useRef<Room | null>(null);
  const serverRoom = useRef("");
  const inFlight = useRef(false);
  const generation = useRef(0);
  const audio = useRef(new Set<HTMLMediaElement>());
  const hushFlag = useRef(false);
  const muteRef = useRef(muted); muteRef.current = muted;
  const lastActivity = useRef(Date.now());
  const stop = useCallback(async () => {
    generation.current++;
    const room = roomRef.current; roomRef.current = null;
    const name = serverRoom.current; serverRoom.current = "";
    meterCleanup.current?.(); meterCleanup.current = null; setInputLevel(0); setInputStatus("");
    setState("off"); setSpeaking(false); setUserSpeaking(false); setNeedsAudio(false);
    for (const el of audio.current) el.remove(); audio.current.clear();
    await room?.disconnect();
    if (name) await assistantFetch(transport, "/voice/end", { room: name }).catch(() => setError("Voice disconnected locally; verify the LiveKit room has ended."));
  }, [transport]);
  const start = useCallback(async () => {
    if (inFlight.current) { setError("The previous connection is still closing. Try again in a moment."); return; }
    if (roomRef.current || paused) return;
    const gen = ++generation.current;
    inFlight.current = true; setState("connecting"); setError(""); setTranscripts([]); hushFlag.current = false;
    try {
      const info = await assistantFetch<{ url: string; token: string; room: string }>(transport, "/voice/token", { target });
      if (gen !== generation.current) { await assistantFetch(transport, "/voice/end", { room: info.room }); return; }
      serverRoom.current = info.room;
      const room = new Room({ adaptiveStream: true, dynacast: true }); roomRef.current = room;
      room.on(RoomEvent.AudioPlaybackStatusChanged, (allowed) => { if (roomRef.current === room) setNeedsAudio(!allowed); });
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) return;
        const element = track.attach(); element.muted = muteRef.current || hushFlag.current; element.style.display = "none"; document.body.append(element); audio.current.add(element);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => { for (const el of track.detach()) { audio.current.delete(el); el.remove(); } });
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        setSpeaking(speakers.some((p) => p.identity !== room.localParticipant.identity));
        setUserSpeaking(speakers.some((p) => p.identity === room.localParticipant.identity));
        if (speakers.length) lastActivity.current = Date.now();
      });
      room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
        lastActivity.current = Date.now();
        const who = participant?.identity === room.localParticipant.identity ? "You" : "Jev";
        if (who === "You") { hushFlag.current = false; for (const el of audio.current) el.muted = muteRef.current; }
        for (const s of segments) setTranscripts((old) => [...old.filter((i) => i.id !== s.id), { id: s.id, who, text: s.text }].slice(-6));
      });
      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== room) return;
        void assistantFetch<VoiceConnection>(transport, "/voice/connection", { room: info.room }).catch(() => undefined).then(async (connection) => {
          if (roomRef.current !== room) return;
          await stop(); setError(voiceFailureMessage(connection?.failure));
        });
      });
      await room.connect(info.url, info.token);
      if (gen !== generation.current) { await room.disconnect(); return; }
      // Joining LiveKit alone is not proof that the voice model is connected.
      const end = Date.now() + 35000;
      for (;;) {
        if (gen !== generation.current) return;
        const connection = await assistantFetch<VoiceConnection>(transport, "/voice/connection", { room: info.room });
        if (connection.state === "failed") throw new Error(voiceFailureMessage(connection.failure));
        if (connection.state === "ready") break;
        if (Date.now() > end) throw new Error("The live voice model did not connect. Check your account settings and try again.");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      // Safari can require a second user gesture after the network connection completes.
      await room.startAudio().catch(() => {});
      setNeedsAudio(!room.canPlaybackAudio);
      if (gen !== generation.current) return;
      let publication;
      try { publication = await room.localParticipant.setMicrophoneEnabled(true, { deviceId: inputDevice, echoCancellation: true, noiseSuppression: true, autoGainControl: true }); }
      catch (e) {
        if (inputDevice === "default" || !(e instanceof Error) || !["NotFoundError", "OverconstrainedError"].includes(e.name)) throw e;
        setInputDevice("default"); try { localStorage.removeItem("jarvis-microphone"); } catch {}
        publication = await room.localParticipant.setMicrophoneEnabled(true, { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
      }
      if (!publication?.track || publication.isMuted) throw new Error("The microphone did not start. Choose an input and try again.");
      if (gen !== generation.current) { await room.localParticipant.setMicrophoneEnabled(false); return; }
      await watchMicrophone(room, publication.track.mediaStreamTrack);
      if (gen !== generation.current) return;
      lastActivity.current = Date.now(); setState("on");
    } catch (e) { if (gen === generation.current) { await stop(); setError(e instanceof Error && e.name === "NotAllowedError" ? "Microphone access was denied. Allow Jarvis in System Settings → Privacy & Security → Microphone, then try again." : e instanceof Error ? e.message : "Voice could not connect"); } }
    finally { inFlight.current = false; }
  }, [transport, target, paused, stop, inputDevice, watchMicrophone]);
  const retryMicrophone = useCallback(async (deviceId = inputDevice) => {
    const room = roomRef.current;
    if (!room || state !== "on" || retrying.current) return;
    retrying.current = true; setInputBusy(true);
    setInputStatus("Reconnecting microphone…");
    try {
      // Recreate capture rather than merely unmuting a dead track.
      await room.localParticipant.setMicrophoneEnabled(false);
      const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (publication?.track) await room.localParticipant.unpublishTrack(publication.track, true);
      if (roomRef.current !== room) return;
      const next = await room.localParticipant.setMicrophoneEnabled(true, { deviceId, echoCancellation: true, noiseSuppression: true, autoGainControl: true });
      if (roomRef.current !== room) return;
      if (!next?.track || next.isMuted) throw new Error("The microphone did not start.");
      await watchMicrophone(room, next.track.mediaStreamTrack);
      setError("");
    } catch { if (roomRef.current === room) setInputStatus("Could not open this microphone. Choose another input and retry."); }
    finally { retrying.current = false; setInputBusy(false); }
  }, [state, inputDevice, watchMicrophone]);
  const changeInput = useCallback(async (deviceId: string) => {
    if (retrying.current) return;
    setInputDevice(deviceId); try { localStorage.setItem("jarvis-microphone", deviceId); } catch {}
    await retryMicrophone(deviceId);
  }, [retryMicrophone]);
  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refreshDevices);
  }, [refreshDevices]);
  useEffect(() => { for (const el of audio.current) el.muted = muted || hushFlag.current; }, [muted]);
  useEffect(() => { if (paused) void stop(); }, [paused, stop]);
  useEffect(() => {
    let checking = false;
    const check = setInterval(() => {
      const name = serverRoom.current;
      if (state !== "on" || !name || checking) return;
      checking = true;
      void assistantFetch<VoiceConnection>(transport, "/voice/connection", { room: name }).then(async (c) => {
        if (serverRoom.current === name && c.state === "failed") { await stop(); setError(voiceFailureMessage(c.failure)); }
      }).catch(() => {}).finally(() => { checking = false; });
    }, 2000);
    return () => clearInterval(check);
  }, [state, transport, stop]);
  useEffect(() => {
    const timer = setInterval(() => { if (roomRef.current && Date.now() - lastActivity.current > 3 * 60000) { void stop(); setError("Voice ended after three quiet minutes. Your tasks continue."); } }, 15000);
    return () => { clearInterval(timer); void stop(); };
  }, [stop]);
  const hush = useCallback(() => { hushFlag.current = true; for (const el of audio.current) el.muted = true; setSpeaking(false); }, []);
  const changeTarget = useCallback(async (next: WorkTarget) => { const name = serverRoom.current; if (name) await assistantFetch(transport, "/voice/target", { room: name, target: next }); }, [transport]);
  const enableAudio = useCallback(async () => { try { await Promise.all([roomRef.current?.startAudio(), meterContext.current?.resume()]); setNeedsAudio(roomRef.current ? !roomRef.current.canPlaybackAudio : false); } catch { setError("Tap to enable sound again, and check your phone’s audio output."); } }, []);
  return { state, error, speaking, userSpeaking, transcripts, start, stop, hush, changeTarget, needsAudio, enableAudio, devices, inputDevice, inputLevel, inputStatus, inputBusy, inputProblem: /^(No microphone|Microphone (?:disconnected|is unavailable)|Could not open)/.test(inputStatus), changeInput, retryMicrophone };
}
