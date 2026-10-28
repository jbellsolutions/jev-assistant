# Working on Jarvis (formerly Jev Assistant)

This is the canonical new project folder. Read README.md and docs/architecture.md before implementation. The existing Electron app, local companion and Chrome extension are now integrated here. Read docs/verification.md before making claims about live account or audio behavior.

- Follow the user's current direction: LiveKit + GPT-Live 1; TypeSafe Jev for judgments; GPT-6 Luna for worker reasoning; Browser Use Cloud. Preserve the Electron desktop app and include the local companion and Chrome extension from the start; they are central to the user's Jarvis-like assistant.
- The product name is Jarvis; TypeSafe Jev remains the model name. Keep legacy bundle IDs, private data paths and protocol IDs compatible through the rename.
- Keep voice sessions independent of persistent task execution. Start with one worker and a queue; retain recovery, cancellation, and evidence from the beginning.
- Prefer Browser Use's hosted V4 agent for the initial browser worker. Do not silently substitute Steel, Browserbase, an old Hermes service, or a new general browser executor.
- Preserve the old folders. The original desktop/control sources and tests have been ported here. Make all new changes in this folder and leave the older projects intact.
- Keep cloud and local targets distinct. Cloud failure does not authorize use of the user's local browser or another machine.
- Honor explicit user authorization within its scope. Ask only for missing material details or actions outside that scope. Model confidence is not authorization.
- Store credentials server-side and task runtime data outside tracked source. Do not log keys, browser cookies, live-view URLs, or raw secret-bearing artifacts.
- Reconcile an uncertain external write before retrying. Verify completion from observed evidence, not a worker's assertion alone.
- Use actual current SDK contracts. In LiveKit GPT-Live client delegation, registered function tools are ignored; handle delegation events in application code.
- Claim voice verification only after a real microphone conversation. Distinguish automated checks, live service checks, and untested behavior in every handoff.
- Phone access must include the same real Mac app/file/task capabilities as desktop voice, alongside the separate Jarvis browser. A paired tunnel alone is not evidence of working Mac access. Check actual Mac observations/actions, provide the phone's Mac picture and manual controls, preserve target isolation, and never answer visibility/access questions with an untested general disclaimer.
- Do not treat legacy verification reports as current service status. The October 11 v12 notes say the old Jev browser VM was deleted.

## Standing publication rule

The owner explicitly authorized ongoing publication on October 27, 2026. For every completed Jev change in this project: run relevant checks and the credential scan, document findings and verification, commit and push the verified changes to the public `jbellsolutions/jev-assistant` repository. Runtime, UI, packaging or Chrome-extension changes also require a new versioned preview installer/extension release, updated download links and checksums. Verify the uploaded assets and CI. Do not silently replace an existing version. Never publish private settings, sessions, logs or user task content. Report any publishing/check failure plainly. This is a per-change completion rule, not an unattended file watcher or permission to publish unrelated work.
