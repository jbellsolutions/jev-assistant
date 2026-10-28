# Start here — Jarvis for Mac

Jarvis is a desktop assistant you can talk to naturally. It can work in Chrome, on your Mac, in its own cloud browser, and on an optional Orgo computer.

## Install

1. Download **Jarvis-1.2.1-mac-arm64.pkg** from the [download page](https://github.com/jbellsolutions/jev-assistant/releases/tag/v1.2.1-preview.1).
2. Open the installer and follow the Mac's instructions. It installs **Jarvis** and **Cua Driver**, the helper for Mac control, in Applications. No coding tools or terminal are needed.
3. Open **Jarvis** from Applications.

**Supported desktop:** Apple Silicon Macs (M1 or newer), macOS 15 or newer. Intel Macs and Windows are not included. iPhone access uses the web companion and a separately configured HTTPS tunnel.

**Preview signing:** this download is an unsigned preview. Normal warning-free distribution still needs the maintainer's Apple Developer signing and notarization. If macOS blocks it, this is a release-signing issue; do not disable your Mac's security protections. A signed release will use the same installer steps.

Upgrading from Jev? Jarvis keeps your private connections, tasks and desktop chat. The installer preserves the former app outside Applications so there is one current app to open.

## Connect your accounts

Choose **Set up Jarvis**, or **Connection settings → Edit connections**. Paste your own connection information, choose **Save connections**, then **Restart Jarvis**. Saved key boxes stay blank; paste a replacement only when changing a key.

| Connection | What it enables | Where to get it |
| --- | --- | --- |
| OpenAI | Natural live voice and reasoning | [OpenAI API](https://platform.openai.com/api-keys) — API credit is separate from a ChatGPT subscription |
| LiveKit | The live voice connection | [LiveKit Cloud](https://cloud.livekit.io/) — project URL, API key and secret |
| TypeSafe Jev | Fast intent and page judgments | [TypeSafe](https://typesafe.ai/) |
| Browser Use | Jarvis's own cloud browser | [Browser Use Cloud](https://cloud.browser-use.com/) |
| Orgo, optional | A separate computer | [Orgo](https://www.orgo.ai/) — key and the computer ID you want to use |
| Composio, optional | Slack, Gmail and ClickUp tools | [Composio](https://dashboard.composio.dev/) — a project key and the user ID owning your connections |

Each service bills its own usage. No account, API credit, login session or private key is included in this download.

## Let Jarvis use Chrome

1. Open **Connection settings → Show Chrome extension**.
2. In Chrome, open the Extensions page, enable **Developer mode**, and choose **Load unpacked**.
3. Select the folder Jarvis opened. Jarvis should show **Chrome connected**.

This one manual Chrome step is required for the preview extension. It is not yet in the Chrome Web Store. Do not load more than one copy.

## Let Jarvis use Mac apps

Choose **Connection settings → Set up Mac control**. In **System Settings → Privacy & Security**, allow **Cua Driver** under **Accessibility** and **Screen Recording**. Mac control is optional if you only want voice and the cloud browser.

Microphone permission is requested when starting a working live conversation. The optional Fn+Control talk key may also need Input Monitoring permission.

## Start talking

Click **Talk to Jarvis**. Speak naturally and interrupt when you need to. There is no recording to submit and no Send button for voice. **End conversation** closes audio; saved tasks continue while this Mac remains awake and Jarvis is running.

The purple orb shows when Jarvis is connecting, listening, hearing you or speaking. Streaming transcripts stay underneath it. You can cancel while connecting. Hiding the window pauses the animation; an active conversation continues.

Choose **My computer**, **Jarvis browser**, or **Co-founder's computer**. Jarvis does not silently switch computers when one is unavailable.

Use **↗ Resize** for a large workspace or compact panel. You can drag window edges too; Jarvis remembers the size. **Option+Space** shows or hides it.

For app tools, add Composio, restart, then choose **Refresh connected apps → Connect**. Finish authorization in your browser. Sends and changes ask for approval.

## Voice approvals and permissions

Jarvis asks pending approval questions aloud during a live conversation. Answer “yes, send it,” “go ahead,” or “no.” Your reply applies to the action just presented. A changed request needs a new review.

Open **Permissions** to allow routine Slack, email or ClickUp API actions on the connected account without asking each time. These switches require that app to be connected through Composio. Browser and Mac writes still ask by voice. Normal macOS privacy permissions are managed separately.

## Your workspace and browser

Drag the divider between the screen and chat, or the divider between voice/tasks and conversation. Double-click a divider to reset it. The window and pane sizes are remembered.

Choose **Jarvis’s browser** or **Work in → Jarvis browser** to use the separate Browser Use cloud browser. **Open browser** starts it; click and type inside its live view. Browser tasks and follow-ups use that session while it remains available. It stays open for up to 15 minutes after its last task, subject to provider limits. **Stop browser** pauses cloud work and closes it; quitting Jarvis also closes it. Browser Use usage is billed by your provider account.

Choose **Your screen** for the Mac or your connected Chrome tab, or **Co-founder’s computer** for Orgo. You can switch where the next task runs during a live call. Existing tasks keep their assigned environment.

## If something doesn't work

- **No API credit available:** add credit to the OpenAI project associated with your key, or replace the key. A ChatGPT subscription does not supply API credit.
- **Chrome not connected:** make sure Jarvis is open; the extension retries automatically. After installing an update, reload the Jarvis extension once in Chrome's Extensions page. If an old copy was loaded from another folder, remove that copy and load the folder opened by **Show Chrome extension**.
- **Mac not connected:** check Cua Driver's permissions, then restart Jarvis.
- **Multiple connected app accounts:** use a Composio user ID with the intended single active account for each app. Jarvis refuses to guess the identity.
- **Update:** quit Jarvis, run the newer installer, and reopen it. Settings and tasks stay in your home folder. Reload the Jarvis extension once to use its new code. This preview has manual app updates.

For iPhone, open **Connect iPhone** on the Mac and follow [Phone setup](phone.md). Pair your phone, then save Jarvis to your Home Screen. Select **Jarvis browser** for cloud research/work or **My computer at home** for your Mac. Tunnel setup is separate; this installer does not create a public URL.
