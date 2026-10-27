import { ServerOptions } from "@livekit/agents";
import { voiceAgentName } from "./identity.js";

export function voiceServerOptions(agent: string, env: NodeJS.ProcessEnv = process.env) {
  const options = new ServerOptions({ agent, agentName: voiceAgentName(env), wsURL: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET, host: "127.0.0.1", production: true, logLevel: "warn" });
  // Agents 1.9.4 uses `value || default` in its constructor: passing zero there
  // silently starts four idle job processes and selects the shared default port.
  options.numIdleProcesses = 0;
  options.port = 0;
  return options;
}
