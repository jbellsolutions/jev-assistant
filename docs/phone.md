# Jarvis on iPhone

Jarvis includes an iPhone web companion connected to the **same desktop app, Mac tools, saved tasks and approvals** on your Mac. It defaults to **My computer at home** and remembers your choice. Choose **Jarvis browser** for its separate Browser Use Cloud browser. An optional configured co-founder computer is also available.

Keep the Mac awake, online and running Jarvis. Voice ends when the phone app leaves the foreground; saved tasks continue on the Mac. This release does not promise background iPhone voice or operation of a sleeping Mac.

## Connect once

1. Install Jarvis 1.3 or newer on your Mac.
2. Provide an HTTPS tunnel to the separate phone listener, normally **127.0.0.1:3112**. Do not forward the desktop port (3111), Chrome bridge or other local services.
3. In Jarvis on Mac, open **Connect iPhone**, enter the tunnel's HTTPS address (no path) and choose **Save phone address**.
4. Choose **Create pairing code**. On your iPhone, open the phone link and enter that code within five minutes. A code works once; creating another replaces it.
5. In Safari, choose **Share → Add to Home Screen → Open as Web App**, name it **Jarvis**, and add it. The Home Screen app may have its own cookie storage; if asked, pair it once more with a new code.

On the phone, **Talk** offers the existing LiveKit conversation and typed tasks. Ask to open Slack, inspect an app, find a folder or prepare a message; Mac requests use the desktop worker's actual Mac/Chrome/file tools and existing approvals. Each Mac task receives a fresh Mac observation, and `mac_read` can return a real screenshot. Voice receives the selected environment and actual connection flags, including changes during a call, rather than assuming a phone cannot reach the Mac.

**Tasks** shows shared progress, results, approvals, pause/resume, corrections and cancellation. **Mac** selects your computer and shows the app window Jarvis is working in, or the app in front. **Browser** selects the separate cloud browser and shows the same interactive provider view as the desktop. Changing tabs updates the next voice/typed request's environment; existing tasks retain their targets.

In **Mac**, verify the picture before enabling **Control this Mac window**. Tap the picture to click, type into a selected field using **Type on Mac**, or use keys such as Enter, Tab, Find, Open and Go to folder. Zoom enlarges the picture. Manual input fronts that exact window; it is the user's own interaction. Pause any active Mac task before taking over. Pictures are refreshed while the view is visible, not continuous desktop video; input is bound to a recent per-device picture, invalidated after each action, and duplicate request IDs are not replayed. Missing pictures report a concrete permission/window problem instead of implying success. Mac Accessibility and Screen Recording grants still belong to Cua Driver on the Mac.

If Safari blocks sound, tap **Tap to enable sound**. A microphone permission prompt is expected when starting voice. End a desktop conversation before starting one on the phone; there is one active conversation at a time. Changing the work environment changes the next voice/typed request, not tasks already running.

## Tailscale Serve example

Install Tailscale on the Mac and iPhone and sign in to the same private network. With an unused HTTPS port, run on the Mac:

```sh
tailscale serve --bg --https=9443 http://127.0.0.1:3112
```

Use the HTTPS address printed by Tailscale, including `:9443`, in **Connect iPhone**. Open that address with `/phone` on the iPhone while Tailscale is connected. This exposes the phone listener to your private Tailscale network, not the public internet. Preserve existing Serve configuration; use an unused port rather than resetting other services.

An authenticated Cloudflare relay or another trusted HTTPS reverse proxy can forward the same phone listener instead. Preserve the original `Host`, `Origin`, cookies and custom request headers, and terminate TLS before forwarding to loopback. Configure the exact external HTTPS origin in Jarvis. Tunnel installation, provider accounts and access policies are separate from Jarvis.

See [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) and [Apple's Home Screen app instructions](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios).

## Remove access

Choose **Remove device** in the Mac's **Connect iPhone** panel, or **Disconnect** on the phone. This invalidates its cookie and requests shutdown of its active voice room; saved tasks remain shared and continue. **Disable phone access** removes all devices. Changing the configured HTTPS address also clears existing pairings. Paired access expires after 30 days; pair again when prompted. Safari and the Home Screen app can appear as separate paired devices.

Phone cookies are Secure, HttpOnly and SameSite=Strict. Only cookie hashes are saved privately on the Mac; provider keys and the desktop/Chrome pairing token never go to the phone. Pairing codes are memory-only, expire in five minutes and allow at most ten guesses. The phone gateway accepts only the configured host/origin and an authenticated route allowlist; desktop WebSockets, private settings and voice-worker callbacks are excluded. No service worker caches task records or results. A tunnel is still a trusted boundary: configure only this listener and protect the tunnel account.

## Verification boundary

Automated tests exercise pairing, expiry, revocation, origin checks, shared task execution, Mac pictures/input and retry IDs. The browser smoke uses real HTTPS with synthetic tasks and checks iPhone layouts in Chromium and WebKit, approval controls, reload and connection errors. Opt-in live scripts additionally test real Mac control and synthetic speech through LiveKit with the owner's connected services. These are **not physical iPhone microphone/audio validation**. Test foreground voice, interruption, lock/switch behavior and cellular reconnection on your own iPhone before relying on them. The Mac view is an app-window preview, not a full desktop video stream; the cloud browser provider's touch viewer and external websites can impose additional mobile limitations.
