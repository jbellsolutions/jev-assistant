# Sources and unresolved checks

Official documentation checked October 26, 2026. Pricing and availability can change. Documentation support does not establish access in the user's accounts.

| Source | What it establishes |
| --- | --- |
| [OpenAI GPT-Live getting started](https://developers.openai.com/api/docs/guides/live) | Full-duplex conversation with separate backend work; application owns task state; WebRTC, WebSocket and SIP paths |
| [OpenAI delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation) | Responses versus client delegation and application responsibilities |
| [OpenAI pricing](https://developers.openai.com/api/docs/pricing) | GPT-Live 1 is $0.05/minute, billed per second; backend model/tool costs are separate |
| [OpenAI GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) | Current model identity and direct API price; not Browser Use's hosted price |
| [LiveKit OpenAI integration](https://docs.livekit.io/agents/integrations/openai/) | GPT-Live integration, device frontends, and telephony support |
| [LiveKit GPT-Live guide](https://docs.livekit.io/agents/models/realtime/gpt-live/) | Plugin/inference choices, client delegation event handling, pending transcript, ignored function tools in client mode, and instruction restrictions |
| [Browser Use product choices](https://docs.browser-use.com/cloud/which-product) | Hosted V4 agent versus CLI/library versus browser-only infrastructure; real Chrome is a separate path |
| [Browser Use V4 models](https://docs.browser-use.com/cloud/agent/models) | GPT-6 Luna support/default and hosted token pricing; browser/network extra |
| [Browser Use billing](https://docs.browser-use.com/cloud/guides/billing) | Pay-as-you-go, orchestration/BYOK costs, soft spending caps, cleanup and full session cost |
| [Browser Use profiles](https://docs.browser-use.com/cloud/guides/authentication) | Persistent cloud login state and separate profile/session semantics |
| [Browser Use human checkpoints](https://docs.browser-use.com/cloud/agent/human-in-the-loop) | Wait for a run to stop before human takeover; continue with the same session; temporary browser lifetime |
| [Browser Use V4 create-run reference](https://docs.browser-use.com/cloud/api-v4/runs/create-run) | Current REST fields including model, session, browser settings and run cost controls |
| [TypeSafe documentation index](https://docs.typesafe.ai/llms.txt) | Current primitives, SDKs, API and relevant cookbook entry points |
| [TypeSafe intent routing](https://docs.typesafe.ai/patterns/intent-routing) | Code routes typed judgments to deterministic handlers or reasoning models |
| [TypeSafe function calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling) | Closed-set decisions and validated argument selection |

## Supplied video

[GPT-Live-1 is now in the API](https://www.youtube.com/watch?v=OSaP6bJoU44). The title was accessible, but the fetched YouTube page did not provide a transcript or usable video contents. The implementation is based on official documentation and inspected installed SDK source/types, not an asserted review of the demonstration.

## Check during implementation

- OpenAI GPT-Live access and paid-tier eligibility, LiveKit project setup, Browser Use project/model access, and actual provider limits.
- Exact compatible LiveKit and Browser Use Node SDK versions; public API schemas can advance ahead of installed SDK types.
- Saved login and checkpoint behavior on Slack, GoHighLevel, and ChatGPT; local Chrome access separately.
- A small always-on hosting choice and durable storage before promising tasks continue when the user's Mac is asleep. LiveKit rates were not fully resolved in this pass; include the chosen plan/agent runtime in any all-in estimate.
- Measured task success, first-response latency, correction handling, recovery and total cost with real audio and real browser workflows.
