# Jarvis 1.4: one permissions setting and visible microphone input

Permissions now shows **Permissions enabled: Yes**. It does not require optional Slack, Gmail or ClickUp accounts to become usable. Owner-requested work can use the selected computer, its browser and connected app tools without routine tool confirmations. The selected target, available connections and macOS grants still determine actual access. Tasks must stay within the user's request; missing material details and new scope still need the user.

The setting is saved privately. Turning it off pauses active/queued tasks and blocks new work, browser startup and task resume until it is enabled again. It does not undo completed or already-in-flight actions. It does not confer these permissions on legacy co-founder-originated requests or let paired phones change the setting.

Voice now validates the published microphone track, lets you select and remember an input, shows its actual sound level, and offers **Retry microphone** to recreate capture during a conversation. Missing remembered hardware falls back to the system input when connecting. Silent, muted or disconnected capture produces an actionable message; the orb says **Check microphone** when input needs attention. Denied macOS microphone access has a specific recovery instruction.

Automated browser checks exercise synthetic audio, silence, missing/denied capture, retry and cleanup. A live-service check sends generated speech through the actual renderer, LiveKit and GPT-Live and verifies an answer and audio playback. These checks do not establish a successful conversation through the owner's physical microphone; that remains a hands-on check with the selected hardware.

The unsigned Apple Silicon preview installer and clean unpacked Chrome extension are published under a new release with checksums. Existing private settings and saved tasks remain outside the application bundle. The existing preview signing and Chrome Load unpacked limitations remain.
