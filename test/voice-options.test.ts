import { expect, it } from "vitest";
import { voiceServerOptions } from "../server/voice/options.js";
import { voiceAgentName } from "../server/voice/identity.js";
it("routes a shared LiveKit project to the right installation without exposing its private token", () => {
  const first = voiceAgentName({ JEV_TOKEN: "private-local-fixture-one" });
  expect(first).toBe(voiceAgentName({ JEV_TOKEN: "private-local-fixture-one" }));
  expect(first).not.toBe(voiceAgentName({ JEV_TOKEN: "private-local-fixture-two" }));
  expect(first).not.toContain("private-local");
});
it("keeps the desktop voice service on an ephemeral private port without prewarming unused processes", () => {
  const options = voiceServerOptions("file:///local/agent.mjs", {});
  expect(options.numIdleProcesses).toBe(0);
  expect(options.port).toBe(0);
  expect(options.host).toBe("127.0.0.1");
  expect(options.agentName).toBe("jev-assistant");
  expect(options.production).toBe(true);
});
