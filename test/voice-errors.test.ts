import { describe, expect, it } from "vitest";
import { classifyVoiceFailure } from "../server/assistant/voice-errors.js";
import { voiceFailureMessage } from "../core/voice-connection.js";
describe("live voice failures", () => {
  it("identifies billing and authentication without returning raw provider details", () => {
    expect(classifyVoiceFailure({ code: "credit_balance_exhausted" })).toBe("quota");
    expect(classifyVoiceFailure(new Error("insufficient_quota"))).toBe("quota");
    expect(voiceFailureMessage("quota")).toContain("API credit");
    expect(classifyVoiceFailure({ status: 401 })).toBe("authentication");
    expect(voiceFailureMessage(classifyVoiceFailure(new Error("unexpected response with private data")))).not.toContain("private data");
  });
});
