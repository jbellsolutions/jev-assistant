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
    setState("off"); setSpeaking(false);
    for (const el of audio.current) el.remove(); audio.current.clear();
    await room?.disconnect();
    if (name) await assistantFetch(transport, "/voice/end", { room: name }).catch(() => setError("Voice disconnected locally; verify the LiveKit room has ended."));
  }, [transport]);
  const start = useCallback(async () => {
    if (inFlight.current || roomRef.current || paused) return;
    const gen = ++generation.current;
    inFlight.current = true; setState("connecting"); setError(""); setTranscripts([]); hushFlag.current = false;
    try {
      const info = await assistantFetch<{ url: string; token: string; room: string }>(transport, "/voice/token", { target });
      if (gen !== generation.current) { await assistantFetch(transport, "/voice/end", { room: info.room }); return; }
      serverRoom.current = info.room;
      const room = new Room({ adaptiveStream: true, dynacast: true }); roomRef.current = room;
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) return;
        const element = track.attach(); element.muted = muteRef.current || hushFlag.current; element.style.display = "none"; document.body.append(element); audio.current.add(element);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => { for (const el of track.detach()) { audio.current.delete(el); el.remove(); } });
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => setSpeaking(speakers.some((p) => p.identity !== room.localParticipant.identity)));
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
      await room.startAudio();
      await room.localParticipant.setMicrophoneEnabled(true);
      lastActivity.current = Date.now(); setState("on");
    } catch (e) { await stop(); setError(e instanceof Error ? e.message : "Voice could not connect"); }
    finally { inFlight.current = false; }
  }, [transport, target, paused, stop]);
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
  return { state, error, speaking, transcripts, start, stop, hush };
}
