# Jarvis — your voice desktop assistant

Formerly Jev. A voice assistant that can work in Chrome, on your Mac, in its own cloud browser, and on an optional Orgo computer. Natural two-way conversation uses **LiveKit + GPT-Live 1**. **TypeSafe Jev** makes fast judgments; **GPT-6 Luna** handles reasoning and task execution.

## Download and install

**[Download the Mac installer](https://github.com/jbellsolutions/jev-assistant/releases/tag/v1.4.0-preview.1)** · **[Start here](docs/start-here.md)**

Open the `.pkg`, follow the Mac installer, and launch Jarvis from Applications. It includes the Mac-control helper. End users do not need Node, Python, a terminal or coding tools.

The first release targets **Apple Silicon Macs with macOS 15+**. It is an **unsigned preview**: warning-free distribution still requires Apple signing and notarization. Chrome also has one manual Load unpacked step until the extension is published in the Chrome Web Store. These are the remaining installation limitations; this preview is not advertised as a zero-setup app.

Bring your own OpenAI, LiveKit, TypeSafe and Browser Use connections. Orgo and Composio are optional. Provider accounts and charges are separate. Keys are entered through **Connection settings → Edit connections**, stored privately on your computer, and excluded from this download and repository.

## What you can do

- Start a continuous conversation with **Talk to Jarvis**, interrupt naturally, and end it without cancelling tasks.
- See a purple voice orb react to the conversation, with streaming transcripts underneath. Choose a microphone, check its actual input level and reconnect it without ending the conversation. The visual pauses when hidden.
- Give multi-step tasks and see saved progress, results, approvals, pause/resume and corrections.
- Choose **My computer**, **Jarvis browser**, or **Co-founder's computer** explicitly.
- Use your Chrome login sessions through the extension, or an independent Browser Use Cloud browser.
- Use optional Slack, Gmail and ClickUp API tools through Composio, with one Permissions enabled setting for requested work.
- Drag the dividers to resize browser versus chat and voice/tasks versus conversation. Sizes are remembered.
- Click and type directly in the local screen and Jarvis’s separate Browser Use browser. Follow-up cloud tasks reuse the live session.
- Switch between a larger workspace and compact panel with **↗ Resize**. Your window size is remembered.

Local work requires this Mac to remain awake with Jarvis running. Task completion is a worker result with evidence to review, not a guarantee of arbitrary external outcomes.

Already installed? Quit Jev or Jarvis, install the newer preview, then reopen it. Your settings and tasks are preserved. Reload the Jarvis extension once in Chrome's Extensions page to activate its updated code. See [Jarvis 1.4 changes](docs/jarvis-1.4.md).

## iPhone

Jarvis includes a phone companion saved using **Safari → Share → Add to Home Screen**. It connects to this Mac through your HTTPS tunnel and shares its real Mac tools, tasks and approvals. The **Mac** tab shows the primary display and offers direct click, text and key controls; **Browser** selects Jarvis’s separate cloud browser. Mac tasks can open apps, inspect windows and find files just as desktop requests do. Open **Connect iPhone** on the Mac to configure the link and pair a device. The Mac must stay awake with Jarvis running. [Phone setup and testing limits](docs/phone.md).

## For developers

Use Node 22 on an Apple Silicon Mac:

```sh
npm ci
npx playwright install chromium
npm run build:keys
npm run build:audio-out
npm run build:all
npm run app:run
```

The app creates `~/.jev-assistant/.env`, its private pairing token and a stable unpacked extension folder. See `.env.example`. Use the in-app editor for connections; saved values override inherited values on restart. The companion binds loopback port 3111. The renderer never receives provider keys.

```sh
npm run check
npm run dist:mac
npm run smoke:package
npm run build:installer
```

The installer downloads and verifies a pinned signed Cua Driver release. It installs that helper and Jarvis in Applications; configuration and tasks remain outside the app. See [Release process](docs/releasing.md) for Apple signing, notarization, checksums and CI.

[Architecture](docs/architecture.md) · [Verification](docs/verification.md) · [Phase 1 handoff](docs/phase-1.md) · [Contributing](CONTRIBUTING.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)
