# Jev Assistant — Phase 1

A voice assistant that can work in Chrome, on your Mac, in its own cloud browser, and on an optional Orgo computer. Natural two-way conversation uses **LiveKit + GPT-Live 1**. **TypeSafe Jev** makes fast judgments; **GPT-6 Luna** handles reasoning and task execution.

## Download and install

**[Download the Mac installer](https://github.com/jbellsolutions/jev-assistant/releases/tag/v1.0.0-preview.1)** · **[Start here](docs/start-here.md)**

Open the `.pkg`, follow the Mac installer, and launch Jev from Applications. It includes the Mac-control helper. End users do not need Node, Python, a terminal or coding tools.

The first release targets **Apple Silicon Macs with macOS 15+**. It is an **unsigned preview**: warning-free distribution still requires Apple signing and notarization. Chrome also has one manual Load unpacked step until the extension is published in the Chrome Web Store. These are the remaining installation limitations; this preview is not advertised as a zero-setup app.

Bring your own OpenAI, LiveKit, TypeSafe and Browser Use connections. Orgo and Composio are optional. Provider accounts and charges are separate. Keys are entered through **Connection settings → Edit connections**, stored privately on your computer, and excluded from this download and repository.

## What you can do

- Start a continuous conversation with **Talk to Jev**, interrupt naturally, and end it without cancelling tasks.
- Give multi-step tasks and see saved progress, results, approvals, pause/resume and corrections.
- Choose **My computer**, **Cloud browser**, or **Co-founder's computer** explicitly.
- Use your Chrome login sessions through the extension, or an independent Browser Use Cloud browser.
- Use optional Slack, Gmail and ClickUp API tools through Composio, with approval before sends and changes.
- Switch between a larger workspace and compact panel with **↗ Resize**. Your window size is remembered.

Local work requires this Mac to remain awake with Jev running. Task completion is a worker result with evidence to review, not a guarantee of arbitrary external outcomes.

## iPhone

The simplest next step is a secure web companion saved using **Safari → Share → Add to Home Screen**. A phone URL, device pairing and real iPhone testing are not included in this desktop release. [Phone access and the next step](docs/phone.md).

## For developers

Use Node 22 on an Apple Silicon Mac:

```sh
npm ci
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

The installer downloads and verifies a pinned signed Cua Driver release. It installs that helper and Jev in Applications; configuration and tasks remain outside the app. See [Release process](docs/releasing.md) for Apple signing, notarization, checksums and CI.

[Architecture](docs/architecture.md) · [Verification](docs/verification.md) · [Phase 1 handoff](docs/phase-1.md) · [Contributing](CONTRIBUTING.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)
