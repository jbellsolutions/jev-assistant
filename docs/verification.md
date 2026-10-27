# Phase 1 verification

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

The following are not claimed as independently verified for every installer user: a clean physical Mac installation, Apple notarization, Chrome Web Store installation, authenticated Slack/GoHighLevel/ChatGPT workflows, live Composio execution, exhaustive exactly-once external effects, Intel/Windows support, or iPhone access. Native Mac permissions must be granted by each user.

See [Phase 1 handoff](phase-1.md) for release-specific results and limitations.
