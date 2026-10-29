/** Browser fixture: synthetic Web Audio capture; no physical microphone or provider calls. */
export const Track = { Kind: { Audio: "audio" }, Source: { Microphone: "microphone" } };
export const RoomEvent = { AudioPlaybackStatusChanged: "playback", TrackSubscribed: "subscribed", TrackUnsubscribed: "unsubscribed", ActiveSpeakersChanged: "speakers", TranscriptionReceived: "transcription", Disconnected: "disconnected" };
export class Room {
  canPlaybackAudio = true;
  private context?: AudioContext;
  private publication?: { track: { mediaStreamTrack: MediaStreamTrack }; isMuted: boolean };
  localParticipant = {
    identity: "owner",
    setMicrophoneEnabled: async (enabled: boolean) => {
      if (!enabled) { if (this.publication) this.publication.isMuted = true; return this.publication; }
      if (location.search.includes("missing")) return undefined;
      if (location.search.includes("denied")) throw new DOMException("Denied", "NotAllowedError");
      this.context = new AudioContext(); await this.context.resume();
      const source = this.context.createOscillator(), gain = this.context.createGain(), output = this.context.createMediaStreamDestination();
      gain.gain.value = location.search.includes("silent") ? 0 : 0.08;
      source.connect(gain); gain.connect(output); source.start();
      this.publication = { track: { mediaStreamTrack: output.stream.getAudioTracks()[0]! }, isMuted: false };
      return this.publication;
    },
    getTrackPublication: () => this.publication,
    unpublishTrack: async () => { this.publication?.track.mediaStreamTrack.stop(); await this.context?.close(); this.publication = undefined; },
  };
  on() { return this; }
  async connect() {}
  async startAudio() {}
  async disconnect() { await this.localParticipant.unpublishTrack(); }
}
