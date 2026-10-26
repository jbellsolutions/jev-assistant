# MVP acceptance checks

These remain the full product acceptance criteria. Automated queue/local bridge checks and source/packaged desktop smokes have passed; see verification.md. Account-backed voice and authenticated workflows still need validation.

## First vertical slice

1. Open the same app on the computer and phone. Connect microphone/speaker audio and hold a real conversation. Check overlapping speech, a pause while thinking, interruption, and correct proper names.
2. Speak a request to compare three public pages. Jev routes it, the task is saved, Luna executes through Browser Use V4, and the UI shows live progress and source links.
3. Keep speaking while the browser works; the assistant responds without blocking. Ask task status and get saved facts rather than an invented result.
4. End the voice connection while work continues. Reconnect and recover the same task/result without creating duplicate runs.
5. Restart the application backend during a task. Reconcile the remote run and resume event collection. Separately test an ambiguous dispatch timeout and an ambiguous external write.

## Productive account workflow

- Log into one chosen app in the cloud browser and demonstrate login reuse.
- For Slack: resolve the exact Xander and workspace, preserve the requested message, send only within actual authorization, and verify the resulting message in the intended conversation. Retry after a simulated lost response without sending twice.
- For GoHighLevel: select the right subaccount, perform a narrowly scoped requested change, then independently reread it. Avoid broad account changes during initial verification.
- For ChatGPT: create the requested project/chat, submit the exact prompt, and verify the resulting project and chat. Clarify whether “folder” means a ChatGPT Project if that changes the requested outcome.

Implement and test one of these account workflows first. The remaining examples stay unverified until actually exercised.

## Multi-step behavior

- Save a project plan with dependent steps and visible statuses.
- Add a correction while a step runs; subsequent actions use the latest task revision.
- Ask an ambiguous-recipient question before any message dispatch.
- Stop speech without stopping the task; pause a task without discarding it; cancel a remote run and report any already-completed effects.
- Recover after a browser expires and after a login requires human interaction.
- Reject an unavailable cloud/local target without operating in another environment.
- Show failures and evidence truthfully; a provider `completed` status or agent success claim alone does not prove the user's goal succeeded.

## Cost and experience

- Measure total cost and latency on ten representative runs, including at least one failure/recovery case.
- Show connected voice time separately from background task time.
- Release owned cloud browsers when finished and end idle voice connections.
- Verify phone behavior with the actual target browser. Screen locking/background suspension may end a web audio session; saved tasks must remain recoverable.
- Do not mark the MVP productive until one authenticated workflow works end to end and its interruption/recovery behavior is demonstrated.
