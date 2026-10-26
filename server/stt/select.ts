/** Which speech-to-text engine to use. ElevenLabs when it has a key (better, especially on
 *  proper nouns), Apple on-device otherwise (free, offline), nothing if neither is available. */
import { AppleSpeechProvider, appleSpeechAvailable, defaultAppleBin } from "./apple.js";
import { ElevenLabsSpeechProvider, elevenLabsAvailable } from "./elevenlabs.js";
import type { SttProvider } from "./types.js";

export interface SelectSttOptions {
  /** Path to the jev-speech helper; defaults to the one beside the repo. */
  appleBin?: string;
}

/** `STT_PROVIDER` pins an engine ("elevenlabs" | "apple" | "off"); unset picks the best available. */
export function selectSttProvider(env: NodeJS.ProcessEnv = process.env, opts: SelectSttOptions = {}): SttProvider | null {
  const want = env.STT_PROVIDER?.trim().toLowerCase();
  if (want === "off") return null;

  const appleBin = opts.appleBin ?? defaultAppleBin();
  const eleven = () => (elevenLabsAvailable(env) ? new ElevenLabsSpeechProvider({ apiKey: env.ELEVENLABS_API_KEY!.trim(), modelId: env.ELEVENLABS_STT_MODEL?.trim() || undefined }) : null);
  const apple = () => (appleSpeechAvailable(appleBin) ? new AppleSpeechProvider({ bin: appleBin }) : null);

  if (want === "elevenlabs") return eleven();
  if (want === "apple") return apple();
  return eleven() ?? apple();
}

/** One line for the startup log. */
export function describeStt(provider: SttProvider | null): string {
  if (!provider) return "voice in: off (set ELEVENLABS_API_KEY, or run npm run build:native for on-device)";
  return provider.name === "elevenlabs" ? "voice in: elevenlabs (scribe v2 realtime)" : "voice in: apple (on-device)";
}

/** The always-on listener for wake mode: Apple, and only Apple.
 *
 *  This is a deliberate hard constraint, not a preference. Wake mode streams whatever the room is
 *  saying, continuously — through a cloud engine that is roughly $0.39/hour to listen to silence,
 *  and with the room's audio leaving the Mac. Apple's recogniser is free, on-device and only has
 *  to spot two words, which is the one job it is reliably good at. If the helper is not built,
 *  wake mode is refused rather than quietly billed.
 */
export function selectWakeListener(env: NodeJS.ProcessEnv = process.env, opts: SelectSttOptions = {}): SttProvider | null {
  if (env.STT_PROVIDER?.trim().toLowerCase() === "off") return null;
  const appleBin = opts.appleBin ?? defaultAppleBin();
  return appleSpeechAvailable(appleBin) ? new AppleSpeechProvider({ bin: appleBin }) : null;
}

/** One line for the startup log. */
export function describeWake(listener: SttProvider | null, transcriber: SttProvider | null): string {
  if (!listener) return '"Hey Jev": off (needs the on-device recogniser — npm run build:native)';
  const hears = transcriber && transcriber.name !== listener.name ? transcriber.name : `${listener.name} (on-device)`;
  return `"Hey Jev": on — ${listener.name} listens, ${hears} transcribes`;
}
