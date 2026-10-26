# Jev on iPhone

The easiest next version is an iPhone web companion saved to your Home Screen, using the same LiveKit voice connection and saved tasks as your Mac. A separate App Store app is not needed for that approach.

**Phase 1 is the Mac desktop release. It does not yet provide a working phone URL.** Installing the Mac package, opening the GitHub repo on iPhone, or bookmarking localhost will not connect your phone to Jev.

## What needs to be added

1. A private HTTPS connection to the running Mac, with explicit device pairing, revocation and session authentication. Tailscale Serve is one option restricted to your own devices; it is not enabled by this release.
2. An iPhone layout with a large Talk/End button, task progress and approvals. Provider keys stay on the Mac.
3. Real iPhone tests for microphone permission, audio playback, interruption, disconnection and recovery. Locking the screen or switching apps can suspend web audio.

Do not expose the current companion port publicly or remove its origin/authentication checks as a shortcut. Desktop checks are not a substitute for phone pairing.

The Mac must stay awake with Jev running for Mac/Chrome control. A later always-on host can keep cloud tasks available when the Mac sleeps, but cannot operate a sleeping Mac.

## Save it once the secure phone URL exists

1. Open your personal Jev HTTPS link in **Safari** on iPhone.
2. Pair with Jev on the Mac and allow the microphone when choosing Talk.
3. Tap **Share → Add to Home Screen**. Enable **Open as Web App**, name it **Jev**, and tap **Add**.
4. Launch the Jev icon and keep it in the foreground for voice conversation.

See [Apple's iPhone web-app guide](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios) and [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve). This is a Phase 2 plan, not a claim that mobile access was installed or tested in Phase 1.
