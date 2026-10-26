export type VoiceFailure = "quota" | "authentication" | "unavailable";
export interface VoiceConnection { state: "connecting" | "ready" | "failed"; failure?: VoiceFailure }
export function voiceFailureMessage(code?: VoiceFailure): string {
  if (code === "quota") return "OpenAI has no API credit available. Add credits or resolve the API billing limit, then try live conversation again.";
  if (code === "authentication") return "OpenAI could not authenticate the voice connection. Update the OpenAI key in Edit connections.";
  return "Live voice could not connect. Check your connections and try again.";
}
