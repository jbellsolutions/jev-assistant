# Jarvis 1.2 preview — iPhone companion

This update adds an installable iPhone web companion to the existing desktop app. The phone chooses the same Mac, cloud browser or configured co-founder target and shares the saved task queue, approvals and results. LiveKit voice uses the existing desktop voice worker; only one conversation is active at a time.

**Connect iPhone** in the desktop panel configures the exact HTTPS address, generates a one-use five-minute code, lists paired devices and removes access. A separate loopback phone listener (desktop port plus one by default) accepts a restricted authenticated HTTP surface. The desktop port and Chrome/control WebSockets remain local. HTTPS tunneling is supplied separately; Tailscale Serve is documented. No provider credentials or desktop pairing token are sent to the phone.

The phone provides Talk, Tasks and Browser views, supports typed requests with stable retry IDs, task-bound approval, pause/cancel/resume with corrections, and the existing interactive Browser Use viewer. Phone voice stops when the app leaves the foreground while tasks continue. Safari audio unlock has an explicit tap affordance. Removing a device also requests deletion of its active voice room; revocation during voice dispatch is checked before returning a room token.

This is a web companion, not an App Store binary or an always-on cloud host. The Mac must stay awake with Jarvis running. It performs requested Mac work through the existing assistant; it does not add arbitrary phone remote desktop controls. Physical iPhone audio and microphone behavior still need user testing. See [Phone setup and boundaries](phone.md) and [Verification](verification.md).
