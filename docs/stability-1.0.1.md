# Jev 1.0.1 preview stability update

## What failed

After an interrupted call and shutdown, the old Electron process could remain alive with its companion service stopped. Its tray handler still referenced a destroyed window. Clicking the tray produced `TypeError: Object has been destroyed`; reopening the app hit the same single-instance process. The observed failure was a desktop lifecycle error, not evidence of an OpenAI account failure.

## Changes

- Clear destroyed window references and recreate the panel on reopen. Recover a crashed renderer up to three times. Ignore tray events during shutdown; bound shutdown to eight seconds. Exit explicitly after cleanup: a nested second macOS quit could otherwise leave the single-instance process alive with its service stopped.
- Supervise one voice worker with registration/heartbeat deadlines, automatic restart and bounded retry backoff. Stop the worker if its parent disconnects.
- Journal only locally created LiveKit room IDs in a private file. On relaunch, close abandoned rooms before another call. Reclaim a disconnected renderer's call while preserving a connected owner's conversation. Retain unconfirmed cleanup for retry.
- Permit cancelling voice connection setup. Prevent a cancelled attempt from enabling the microphone or overwriting a newer connection.
- Add a gold voice orb above the existing streaming transcript. It uses LiveKit speaker events and small CSS transform/opacity animations, with hidden-window and reduced-motion support. It creates no audio analyser, animation loop or second microphone capture.
- Slow hidden status refresh and stop the hidden live-view clock. Voice audio continues while the window is hidden until explicitly ended or timed out.
- Correct the LiveKit SDK's zero-value defaults: the desktop now actually starts zero prewarmed job processes and uses an ephemeral loopback health port. Previously, passing zero to the SDK constructor silently selected four idle processes and a shared default port.
- Update Chrome extension to 0.3.1. Keep a single retry timer; ignore late close events from replaced sockets; bound opening and companion probes. Existing pairing and bridge protocol remain compatible.
- Add a standing publication rule to AGENTS.md: checked changes must be committed and pushed, with new versioned preview assets when applicable. Installed previews still update manually.

## Verification

The automated checks cover worker crash/retry/heartbeat/shutdown, persisted room cleanup and failed cleanup retention, protection of a connected caller, simultaneous connection starts, and Chrome socket replacement/reconnection. The isolated desktop smoke additionally exercises destroyed-window recovery, renderer crash recovery, forced termination/relaunch, saved-task recovery and a real unpacked Chrome extension against a local demo.

These checks use disposable profiles and synthetic fixtures. They do not certify all account workflows or replace a real microphone conversation. The preview remains Apple Silicon/macOS 15+, unsigned and manually installed; Chrome still uses Load unpacked. API credit, account permissions and network availability remain necessary.
