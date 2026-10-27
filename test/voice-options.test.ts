import { expect, it } from "vitest";
import { voiceServerOptions } from "../server/voice/options.js";
it("keeps the desktop voice service on an ephemeral private port without prewarming unused processes", () => {
  const options = voiceServerOptions("file:///local/agent.mjs", {});
  expect(options.numIdleProcesses).toBe(0);
  expect(options.port).toBe(0);
  expect(options.host).toBe("127.0.0.1");
  expect(options.agentName).toBe("jev-assistant");
  expect(options.production).toBe(true);
});
