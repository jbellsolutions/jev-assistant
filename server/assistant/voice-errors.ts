import type { VoiceFailure } from "../../core/voice-connection.js";
export function classifyVoiceFailure(error: unknown): VoiceFailure {
  const e = error as { message?: string; code?: string; status?: number } | undefined;
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`;
  if (/insufficient_quota|credit_balance_exhausted|billing_hard_limit|credits?|quota/i.test(text)) return "quota";
  if (e?.status === 401 || /invalid_api_key|authentication|unauthorized/i.test(text)) return "authentication";
  return "unavailable";
}
