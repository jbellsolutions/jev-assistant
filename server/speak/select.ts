/** Which voice Jev speaks with: Fish Audio, else ElevenLabs, else silence.
 *
 *  Silence is a first-class outcome, not a failure: everything else in v9 — the Mac controls, the
 *  timers, the wake word — works with no voice at all, so a missing key must degrade to exactly
 *  today's behaviour rather than breaking startup.
 *
 *  ElevenLabs sits behind Fish because the user's ELEVENLABS_API_KEY has been set the whole time (it
 *  powers speech-to-text), so a missing, expired or out-of-quota Fish key costs a different voice
 *  rather than a silent assistant with nothing on screen to say why. */
import type { Speaker } from "../../core/speak.js";
import { DEFAULT_ELEVENLABS_MODEL, ElevenLabsSpeaker } from "./elevenlabs.js";
import { DEFAULT_FISH_MODEL, FishSpeaker } from "./fish.js";
import { type Player, selectPlayer } from "./player.js";

/** hey-jev's own voice (siri.py:12) — the user asked for "Fish Audio, like hey-jev", so this is
 *  that voice rather than a guess. Overridable: pick another at fish.audio and put its id in
 *  JEV_VOICE_ID; the cache is keyed by voice, so nothing stale gets replayed. */
export const DEFAULT_VOICE_ID = "9a9cf47702da476aa4629e2506d4a857";

export interface SelectSpeakerOptions {
  player?: Player;
  fetch?: typeof fetch;
  onSynthesis?: (ms: number, chars: number) => void;
}

/** ELEVENLABS_TTS_MODEL, or JEV_TTS_MODEL when it names an ElevenLabs model (eleven_…). */
export function elevenLabsModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const own = env.ELEVENLABS_TTS_MODEL?.trim();
  if (own) return own;
  const shared = env.JEV_TTS_MODEL?.trim();
  return shared && /^eleven_/.test(shared) ? shared : null;
}

export function fishAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.FISH_AUDIO_API_KEY?.trim();
}

export function elevenLabsAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.ELEVENLABS_API_KEY?.trim();
}

/** Which voice a given environment resolves to, named — so the log line and the panel indicator
 *  agree with what actually speaks instead of each guessing separately. */
export function chosenVoice(env: NodeJS.ProcessEnv = process.env): "fish" | "elevenlabs" | "off" {
  const want = env.JEV_TTS?.trim().toLowerCase();
  if (want === "off") return "off";
  if (want === "fish") return fishAvailable(env) ? "fish" : "off";
  if (want === "elevenlabs") return elevenLabsAvailable(env) ? "elevenlabs" : "off";
  if (fishAvailable(env)) return "fish";
  if (elevenLabsAvailable(env)) return "elevenlabs";
  return "off";
}

/** `JEV_TTS` pins the voice ("fish" | "elevenlabs" | "off"); unset prefers Fish, then ElevenLabs. */
export function selectSpeaker(env: NodeJS.ProcessEnv = process.env, opts: SelectSpeakerOptions = {}): Speaker | null {
  const voice = chosenVoice(env);
  if (voice === "off") return null;
  if (voice === "elevenlabs") {
    return new ElevenLabsSpeaker({
      apiKey: env.ELEVENLABS_API_KEY!.trim(),
      // its own voice id: JEV_VOICE_ID is a Fish voice, and sending that to ElevenLabs is a 404
      ...(env.ELEVENLABS_VOICE_ID?.trim() ? { voiceId: env.ELEVENLABS_VOICE_ID.trim() } : {}),
      ...(elevenLabsModel(env) ? { model: elevenLabsModel(env)! } : {}),
      ...(opts.player ? { player: opts.player } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.onSynthesis ? { onSynthesis: opts.onSynthesis } : {}),
    });
  }
  return new FishSpeaker({
    apiKey: env.FISH_AUDIO_API_KEY!.trim(),
    voiceId: env.JEV_VOICE_ID?.trim() || DEFAULT_VOICE_ID,
    // an eleven_… model named for the A/B is not a Fish model
    model: (env.JEV_TTS_MODEL?.trim() && !/^eleven_/.test(env.JEV_TTS_MODEL.trim()) ? env.JEV_TTS_MODEL.trim() : "") || DEFAULT_FISH_MODEL,
    ...(opts.player ? { player: opts.player } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.onSynthesis ? { onSynthesis: opts.onSynthesis } : {}),
  });
}

/** One line for the startup log, in the shape describeStt() uses. */
export function describeSpeaker(speaker: Speaker | null, env: NodeJS.ProcessEnv = process.env): string {
  const voice = chosenVoice(env);
  if (!speaker || voice === "off") {
    return env.JEV_TTS?.trim().toLowerCase() === "off"
      ? "voice out: off (JEV_TTS=off)"
      : "voice out: off (set FISH_AUDIO_API_KEY or ELEVENLABS_API_KEY to give Jev a voice)";
  }
  const model = voice === "elevenlabs" ? elevenLabsModel(env) || DEFAULT_ELEVENLABS_MODEL : env.JEV_TTS_MODEL?.trim() || DEFAULT_FISH_MODEL;
  return `voice out: ${voice} (${model}, via ${selectPlayer(env).name})`;
}
