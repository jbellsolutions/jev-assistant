# Start here — Jev for Mac

Jev is a desktop assistant you can talk to naturally. It can work in Chrome, on your Mac, in its own cloud browser, and on an optional Orgo computer.

## Install

1. Download **Jev-1.0.1-mac-arm64.pkg** from the [download page](https://github.com/jbellsolutions/jev-assistant/releases/tag/v1.0.1-preview.1).
2. Open the installer and follow the Mac's instructions. It installs **Jev** and **Cua Driver**, the helper for Mac control, in Applications. No coding tools or terminal are needed.
3. Open **Jev** from Applications.

**Supported first release:** Apple Silicon Macs (M1 or newer), macOS 15 or newer. Intel Macs, Windows and an iPhone app are not included.

**Preview signing:** this download is an unsigned preview. Normal warning-free distribution still needs the maintainer's Apple Developer signing and notarization. If macOS blocks it, this is a release-signing issue; do not disable your Mac's security protections. A signed release will use the same installer steps.

## Connect your accounts

Choose **Set up Jev**, or **Connection settings → Edit connections**. Paste your own connection information, choose **Save connections**, then **Restart Jev**. Saved key boxes stay blank; paste a replacement only when changing a key.

| Connection | What it enables | Where to get it |
| --- | --- | --- |
| OpenAI | Natural live voice and reasoning | [OpenAI API](https://platform.openai.com/api-keys) — API credit is separate from a ChatGPT subscription |
| LiveKit | The live voice connection | [LiveKit Cloud](https://cloud.livekit.io/) — project URL, API key and secret |
| TypeSafe Jev | Fast intent and page judgments | [TypeSafe](https://typesafe.ai/) |
| Browser Use | Jev's own cloud browser | [Browser Use Cloud](https://cloud.browser-use.com/) |
| Orgo, optional | A separate computer | [Orgo](https://www.orgo.ai/) — key and the computer ID you want to use |
| Composio, optional | Slack, Gmail and ClickUp tools | [Composio](https://dashboard.composio.dev/) — a project key and the user ID owning your connections |

Each service bills its own usage. No account, API credit, login session or private key is included in this download.

## Let Jev use Chrome

1. Open **Connection settings → Show Chrome extension**.
2. In Chrome, open the Extensions page, enable **Developer mode**, and choose **Load unpacked**.
3. Select the folder Jev opened. Jev should show **Chrome connected**.

This one manual Chrome step is required for the preview extension. It is not yet in the Chrome Web Store. Do not load more than one copy.

## Let Jev use Mac apps

Choose **Connection settings → Set up Mac control**. In **System Settings → Privacy & Security**, allow **Cua Driver** under **Accessibility** and **Screen Recording**. Mac control is optional if you only want voice and the cloud browser.

Microphone permission is requested when starting a working live conversation. The optional Fn+Control talk key may also need Input Monitoring permission.

## Start talking

Click **Talk to Jev**. Speak naturally and interrupt when you need to. There is no recording to submit and no Send button for voice. **End conversation** closes audio; saved tasks continue while this Mac remains awake and Jev is running.

The gold orb shows when Jev is connecting, listening, hearing you or speaking. Streaming transcripts stay underneath it. You can cancel while connecting. Hiding the window pauses the animation; an active conversation continues.

Choose **My computer**, **Cloud browser**, or **Co-founder's computer**. Jev does not silently switch computers when one is unavailable.

Use **↗ Resize** for a large workspace or compact panel. You can drag window edges too; Jev remembers the size. **Option+Space** shows or hides it.

For app tools, add Composio, restart, then choose **Refresh connected apps → Connect**. Finish authorization in your browser. Sends and changes ask for approval.

## If something doesn't work

- **No API credit available:** add credit to the OpenAI project associated with your key, or replace the key. A ChatGPT subscription does not supply API credit.
- **Chrome not connected:** make sure Jev is open; the extension retries automatically. After installing an update, reload the Jev extension once in Chrome's Extensions page. If an old copy was loaded from another folder, remove that copy and load the folder opened by **Show Chrome extension**.
- **Mac not connected:** check Cua Driver's permissions, then restart Jev.
- **Multiple connected app accounts:** use a Composio user ID with the intended single active account for each app. Jev refuses to guess the identity.
- **Update:** quit Jev, run the newer installer, and reopen it. Settings and tasks stay in your home folder. Reload the Jev extension once to use its new code. This preview has manual app updates.

For iPhone, see [Phone access](phone.md). This Mac installer does not create a phone-access URL.
