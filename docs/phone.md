# Jarvis on iPhone

Jarvis 1.2 includes an iPhone web companion connected to the **same desktop app, saved tasks and approvals** on your Mac. Choose **Jarvis browser** to work in its own Browser Use Cloud browser, or **My computer at home** to use your Mac and connected Chrome. An optional configured co-founder computer is also available.

Keep the Mac awake, online and running Jarvis. Voice ends when the phone app leaves the foreground; saved tasks continue on the Mac. This release does not promise background iPhone voice or operation of a sleeping Mac.

## Connect once

1. Install Jarvis 1.2 on your Mac.
2. Provide an HTTPS tunnel to the separate phone listener, normally **127.0.0.1:3112**. Do not forward the desktop port (3111), Chrome bridge or other local services.
3. In Jarvis on Mac, open **Connect iPhone**, enter the tunnel's HTTPS address (no path) and choose **Save phone address**.
4. Choose **Create pairing code**. On your iPhone, open the phone link and enter that code within five minutes. A code works once; creating another replaces it.
5. In Safari, choose **Share → Add to Home Screen → Open as Web App**, name it **Jarvis**, and add it. The Home Screen app may have its own cookie storage; if asked, pair it once more with a new code.

On the phone, **Talk** offers the existing LiveKit conversation and typed tasks. **Tasks** shows shared progress, results, approvals, pause/resume, corrections and cancellation. **Browser** shows the same cloud browser as the desktop, with direct interaction when the provider viewer is available. The phone does not stream the Mac desktop or provide arbitrary remote mouse/keyboard control; Jarvis performs requested Mac work through its existing worker and permissions.

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

Automated tests exercise pairing, expiry, revocation, origin checks, shared task execution and retry IDs. The browser smoke uses real HTTPS with synthetic tasks and checks iPhone layouts in Chromium and WebKit, approval controls, reload and connection errors. These are desktop browser engines at phone viewport sizes, **not physical iPhone microphone/audio validation**. Test foreground voice, interruption, lock/switch behavior and cellular reconnection on your own iPhone before relying on them. The cloud browser provider's touch viewer and external websites can impose additional mobile limitations.
