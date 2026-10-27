# Jarvis 1.1 preview

Jev's desktop app is now named Jarvis. TypeSafe Jev remains the fast judgment model; LiveKit/GPT-Live and Luna retain their roles. The GitHub repository, private settings folder and application identity remain compatible with earlier releases.

## Conversation and permissions

Pending actions are announced during the voice conversation. Short answers such as “yes, send it,” “go ahead,” and “no, don't send it” apply to the specific action presented by the app. Repeated delivery does not approve a second action, and a changed request must be reviewed again. New approval IDs are announced even when several steps request approval close together. Local voice status updates now arrive once a second.

The Permissions panel can remember Slack sends, email sends/replies and ClickUp creates/updates for an individually connected Composio account. New installations ask first; grants are private to that installation and account. Changing the connected account does not inherit the grant. The owner's current browser/Mac Slack workflow continues to use spoken confirmation until Composio is connected. Browser/Mac gates and macOS privacy grants are separate from these API permissions.

## Workspace

The interface and orb use purple. The chat is wider by default, with a larger message box. Drag the browser/chat divider or voice/conversation divider to adjust prominence; use arrow keys on a focused divider or double-click to reset. Sizes survive a restart. Version 1.1.1 also keeps the divider movement consistent when a smaller display limits the pane height.

Chrome-only live-screen input now carries normalized click coordinates and focused text/keys. Previously, a direct Chrome connection could convert a picture click using a fixed viewport and silently ignore typing. Manual input is ordered independently of agent work so a typed batch reaches the field before Enter.

## Jarvis browser

The browser tab no longer falls back to Your screen. It shows the owned Browser Use Cloud session, accepts direct interaction and reuses that session for follow-up tasks. Selecting a view also selects the next task's environment; a live voice conversation can continue while changing it.

Open browser starts a minimal blank-page task through the existing hosted V4 worker. Successful tasks keep the browser for up to 15 minutes after completion, subject to provider limits. Stop browser pauses active cloud work before closing the owned browser; quitting also closes it. Private browser-ID receipts support recovery without adopting or stopping another session. The viewer can be recovered through the provider's session-filtered browser endpoint if a ready event was missed. Provider keys and CDP addresses remain on the server.

Old queued conversation fragments now restart paused for review. Explicit corrections to a pending action update the active task, including when older tasks are paused.

## Upgrade

Install Jarvis-1.1.1-mac-arm64.pkg and open Jarvis from Applications. The former Jev bundle is preserved outside Applications, and private settings, tasks, pairing and the desktop chat profile remain in their existing locations. The bundled Chrome bridge is 0.4.0; existing users reload their unpacked extension once.

This remains an unsigned Apple Silicon/macOS 15+ preview. API providers, privacy grants, internet access and account permissions remain user supplied. See the current verification report for automated, live-service and human-test boundaries.
