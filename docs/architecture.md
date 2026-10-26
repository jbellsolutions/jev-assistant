# Implemented architecture — October 26, 2026

Phase 1 builds on the Electron desktop app with its local companion and Chrome extension. Phone access is a separate next phase.

```mermaid
flowchart TD
  UI[Existing Electron panel] <--> COMP[Loopback companion]
  UI <--> LK[LiveKit room and GPT-Live 1]
  LK <--> VA[Local LiveKit voice worker]
  VA <--> COMP
  COMP --> JEV[TypeSafe request judgments]
  COMP --> QUEUE[Persistent serial task queue]
  QUEUE --> LOCAL[GPT-6 Luna local worker]
  LOCAL --> EXT[Chrome extension]
  LOCAL --> MAC[Existing Mac driver and controls]
  QUEUE --> CLOUD[Browser Use V4 with GPT-6 Luna]
  QUEUE --> ORGO[Luna worker restricted to Orgo computer]
  LOCAL --> APPS[Verified Composio app tools]
  ORGO --> APPS
  QUEUE <--> STATE[Private task records]
```

## Desktop and local companion

The original React panel, Electron hotkeys/tray/preload, Chrome protocol, native helpers, DOM grounding, Mac driver and supporting tests are retained in the canonical folder. The new task and voice panels sit inside that interface. The original direct Session path remains behind Instant controls.

Electron runs the companion in-process on loopback. The CLI server is another entry point to the same implementation. The task home is private `~/.jev-assistant`, separate from the old `~/.jev` application data. A process ownership lock prevents two companions mutating that task store. Electron also uses its single-instance lock.

Native app access still requires the existing cua-driver and macOS grants. No cloud-to-local fallback is added. A local worker gets local hands only; it cannot use the old Orgo, co-founder or browser-box services.

## Voice

A separate bundled standalone Node process runs the official LiveKit Agents/OpenAI integration, with GPT-Live 1 in client delegation mode. It starts only when OpenAI and LiveKit configuration exists. Using the actual Node executable avoids native WebRTC class collisions with Electron on macOS; RTC is an explicit production dependency. The agent contains no function-tool registration: delegation events go to the authenticated loopback task service.

The event's pending transcript and bounded recent conversation supply task context. A room is assigned a target by the companion when created. The agent cannot choose a different target by changing its request body. Delivery IDs are deduplicated; queued task request IDs survive restarts. Commentary is bounded and returns acknowledgements or terminal task updates to the live model.

The renderer connects microphone/playback directly to LiveKit with a short-lived room-scoped token. It waits for the worker's actual GPT-Live session.started event before enabling microphone capture or declaring a conversation active. Fatal provider errors are classified into quota/authentication/unavailable states without returning raw SDK data; they close the UI session. Every microphone affordance uses this path. Legacy STT/wake capture is disabled in the canonical runtime, and Instant typed controls never changes the voice provider. Provider keys and the local companion token remain server-side. The generated Chrome pairing token is private to its extension folder.

Explicit End conversation disconnects and deletes the room. Idle disconnect, a maximum voice duration, participant-disconnection cleanup and worker shutdown bound connection lifetime. The voice session's end does not cancel the task queue. These SDK paths compile and import, but account-backed audio behavior is not yet verified.

## Models and execution

Local reasoning uses the explicit OpenAI Responses provider and `gpt-6-luna`; the old lead model is off by default. The local worker reuses grounded Chrome and Mac tools, tool approval handling and result observations. It is bounded to 60 steps and 15 minutes per attempt. Reaching a limit saves partial output and pauses the task.

TypeSafe supplies bounded semantic judgments for task status/control/correction routing when connected. Explicit UI target selection and exact known control commands remain code-owned. The retained direct browser/control path still has its original TypeSafe grounding and verification integration. Missing TypeSafe configuration uses the documented limited fallback; it is not shown as a live model connection.

Cloud execution uses Browser Use's V4 hosted agent with explicit Luna/high reasoning, default service tier and a configurable per-run model budget. New sessions use the configured workspace, United States proxy and recording off by default. The app saves acknowledged run/session IDs, event cursors, browser ID and execution deadline. A 15-minute limit cancels the remote run; completion and interruption explicitly stop the owned browser. Cleanup requests have independent timeouts, and an unconfirmed stop blocks resume. This is an application execution deadline, not an unsupported agent-run API timeout field. Status is read before the final event drain. A client timeout never triggers a blind repeat dispatch.

The Browser Use hosted agent is an execution boundary of its own. Its instructions cannot provide a hard application-level pre-click approval guarantee. Use reviewed task scope and the provider's actual handoff behavior; workflows needing a hard gate require a controlled executor/API or manual takeover.

## Task records and recovery

Orgo is a third explicit task/voice target, using the same Luna queue worker with local hands removed and only the Orgo own-tool registered. The old co-founder object supports busy checks and the existing live viewer; the new worker does not delegate to the old Hermes agent. Its selected computer is configured separately from the API key. No computer is created, started or stopped during connection setup.

Composio app tools are available to local/Orgo workers when a project key is configured. Account discovery must succeed, and each supported toolkit must have exactly one active identity for the configured user. Tool execution pins that inspected account. Sends and writes use task-bound approval. Initial toolkit actions remain a small named allowlist for Slack, Gmail and ClickUp. Browser Use hosted runs do not receive these tools. Credentials are updated through narrow desktop IPC, not the companion's HTTP API; only configuration flags and nonsecret IDs/URLs are returned. Writes are atomic, mode 0600, and cannot change internal pairing/ports. A restart applies changes and is refused during active tasks or voice sessions.

Tasks are private atomic JSON records, one per task, rather than SQLite in this MVP. Records include target, original/current goal, revision, request ID, timestamps, status, current/partial output, bounded progress history, pending approval, known hosts, and cloud receipt/cursor data. The queue runs one task at a time across both environments.

Local process interruption is persisted as paused. Resume supplies previous observations and output and instructs the worker to inspect current state before acting. Cloud startup reconnects an acknowledged in-progress run by ID. An uncertain dispatch or stop blocks another dispatch until reconciled. Neither the queue nor arbitrary third-party websites provide a universal exactly-once guarantee.

Task states distinguish queued, running, waiting for a tool approval, paused, worker completed, failed and cancelled. Completion means the worker returned a result, not independent certification of every external effect. Complex multi-step goals can run in one worker attempt; a separate persistent dependency-plan engine is a later feature.

Approval cards are bound to a task and unique current request. Broad grants are rejected in the new task service. Model confidence is never authorization. Pausing/cancelling aborts the local worker and requests remote cancellation when applicable; effects already in flight require reconciliation.

## Security and packaging

The companion binds IPv4/IPv6 loopback. New task routes require bearer auth or an exact allowed-origin renderer with a non-simple header. The Chrome bridge always requires its pairing token. Foreign browser origins are rejected.

Electron keeps context isolation and disables Node integration in the renderer. Microphone permission is requested by the actual conversation path, not merely app startup. Main-window navigation stays on the companion origin; external HTTP links open in the user's browser.

The app package excludes `.env` and paired extension credentials. On startup it creates/refreshes a stable private unpacked extension folder. Existing machine endpoints, old deployments and old private credentials were not carried into the new default configuration.

## Future work

After account/audio validation, test real Slack, GoHighLevel and ChatGPT workflows, improve outcome classification and step-level evidence, and measure cost/latency on representative tasks. Add project dependencies, remote phone access and an always-on host only after the local desktop loop is dependable.
