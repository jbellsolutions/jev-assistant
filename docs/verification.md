# Phase 1 verification

## Jarvis 1.2 iPhone companion

**916 tests in 76 files** passed, plus TypeScript and the renderer build. Seven new gateway tests cover one-use pairing, private hashed-cookie persistence, device/code expiry, bounded guesses, revocation, HTTPS-origin checks, excluded control/settings/worker routes, shared cloud/Mac tasks, duplicate request IDs, logout and the desktop management boundary.

The phone smoke passed in **Chromium and WebKit at an iPhone 13 viewport through a real local HTTPS reverse proxy**. With synthetic tasks and disposable profiles it paired, submitted cloud and Mac work to the shared queue, approved a pending action, preserved access across reload, surfaced missing voice/browser credentials, rejected revoked access and checked horizontal layout. It performs no real sends or provider work. Screenshots were visually reviewed. The initial smoke assertion expected a connection label without its adjacent button text; the locator was corrected to the actual connection indicator before both complete browser runs passed.

The relocated 1.2.0 package smoke passed: phone configuration/code presentation/disable, connection editing, cancellation during voice startup, real isolated Chrome clicks/typing, divider persistence, embedded viewer interaction, renderer/window recovery, graceful quit, saved tasks across restart, and forced termination/relaunch with Chrome reconnection. Packaged voice dependencies resolved inside the relocated application. The source credential scan found no credential findings.

These checks do not constitute physical iPhone microphone, audio, interruption, cellular reconnect or background behavior verification. The phone shares the existing LiveKit path; a human conversation on real iPhone hardware remains required. The desktop retains its unsigned Apple Silicon/macOS 15+ preview status. HTTPS tunnel ownership/access and an awake Mac are prerequisites. [Setup, architecture and limits](phone.md).

## Jarvis 1.1 update

The product is now Jarvis, with purple styling, two adjustable workspace dividers, interactive local Chrome input, a separate Browser Use viewer and account-specific remembered API permissions. The private profile and application identity remain compatible with Jev.

**909 tests in 75 files** passed with TypeScript and renderer builds. Added checks cover permission storage/account isolation, natural approval replies, stale/repeated voice replies, changing voice task targets, retained cloud sessions, owned-browser recovery, missing ready-event viewer lookup and safe installer migration, paused startup recovery and corrections with older paused tasks. The desktop smoke also tests real Chrome picture clicks, focused typing plus Enter, divider persistence/reset and an interactive embedded viewer fixture.

Live-service checks used disposable profiles and synthetic data. Through LiveKit/GPT-Live, Jarvis spoke a pending approval, transcribed a simulated microphone answer from Chromium's fake audio device, approved exactly one mock send and closed its room. No actual Slack message was sent. A separate Browser Use check opened the viewer, reused its session for a follow-up, verified a public page, accepted a manual click through the live iframe and independently confirmed browser shutdown. Credentials, live-view links and raw logs remain private.

The first GitHub 1.1.0 build found a divider assertion failure on its smaller virtual display. Inspection showed that flexible shrinking could make the rendered pane shorter than its requested size; dragging from that rendered size could move it in the wrong direction. Version 1.1.1 gives the pane an exact bounded height and tests shrinking and persistence with eventual layout assertions. The original CI failure is retained as evidence, not counted as a pass. A local embedded-viewer fixture also timed out during a tab switch; the harness now waits for the local picture to mount and explicitly restores the test window before loading that fixture. The subsequent complete relocated-package check passed. This fixture check is separate from the live Browser Use check above.

These automated service checks do not replace a new human microphone conversation or verify arbitrary authenticated workflows. The owner's Composio key is not configured, so remembered API permissions cannot be enabled for their Slack account yet; browser/Mac requests use spoken confirmation. Existing preview signing and platform limitations still apply. See [Jarvis 1.1 changes](jarvis-1.1.md).

## October 27 stability update

Version 1.0.1 adds desktop shutdown/reopen recovery, supervised voice-worker recovery, abandoned LiveKit room cleanup, Chrome reconnection fixes, and a lightweight gold voice orb above streaming transcripts. See [findings and changes](stability-1.0.1.md).

Current checks: **896 tests in 73 files** passed, along with TypeScript and renderer builds. The expanded relocated installer-app smoke verifies cancellation during connection setup, renderer crash recovery, destroyed-window recreation, bounded native process exit, forced termination/relaunch, saved tasks, Chrome reconnection and a real local demo action. Disposable test profiles do not contain signed-in accounts.

With the owner's existing settings, a synthetic spoken prompt connected through LiveKit/GPT-Live and produced non-silent return audio without capturing the physical microphone. A separate forced termination during a live session recovered after relaunch, preserved the saved-task count, stopped the old voice worker, and left zero LiveKit rooms. This is automated live-service evidence, not a new human microphone conversation or verification of all external task workflows.

After correcting the SDK's idle-process defaults, a 15-second sample of the installed app plus its descendant processes measured approximately **4.2% of one CPU core with the screen preview visible**, and **2.2% of one core with the native window confirmed hidden**. There were two standalone Node processes (the voice supervisor's worker and the SDK's shared inference process), with no spare job processes. These are short idle measurements on the development Mac, excluding unrelated Chrome activity and the separately shared Cua Driver service; active calls/tasks and other machines will differ.

The owner accepted the desktop experience on October 26, 2026 and reported that it worked well. This is owner feedback; no microphone recording is stored in this repository.

## Automated checks

Before release packaging, 882 tests in 68 files passed, plus TypeScript and renderer builds. Coverage includes queue persistence, target isolation, cloud cancellation and browser cleanup, approvals, account pinning, credential storage, authentication boundaries, and voice readiness/error handling.

The relocated package smoke uses disposable Electron/Chromium profiles. It verifies private settings editing, absence of the old record/transcribe mic, task recovery across restart, a real extension connection and a click on the local demo. Voice/native dependencies must resolve inside the copied app rather than the source checkout. It makes no paid model calls and does not use signed-in browser tabs.

## Service checks performed during development

- LiveKit project authentication and worker registration.
- A TypeSafe intent judgment.
- A Browser Use public-page task using Luna, followed by browser shutdown and an independent stopped-state check.
- Orgo screenshot and live-desktop protocol handshake on a pre-existing selected computer.
- The installed LiveKit voice path correctly surfaced an OpenAI credit error before enabling microphone capture. That was an earlier account state, not a permanent restriction of the app.

No credentials, account identifiers, private project IDs, browser sessions, task records or raw provider logs are included here.

## Remaining validation

The following are not claimed as independently verified for every installer user: a clean physical Mac installation, Apple notarization, Chrome Web Store installation, authenticated Slack/GoHighLevel/ChatGPT workflows, live Composio execution, exhaustive exactly-once external effects, Intel/Windows support, or physical iPhone audio. Native Mac permissions must be granted by each user.

See [Phase 1 handoff](phase-1.md) for release-specific results and limitations.
