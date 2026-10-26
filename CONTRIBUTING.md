# Contributing

Read README.md and docs/architecture.md first. Use Node 22 on an Apple Silicon Mac. Run npm ci, build the optional native helpers, then npm run check.

Keep the voice conversation separate from saved task execution. Preserve explicit local/cloud/Orgo boundaries and existing approvals. Model confidence never grants permission. Reconcile uncertain external writes before repeating them.

Never commit credentials, browser sessions, task records or local machine configuration. Use .env.example for field names only. Keep API keys server-side; credential-editor responses must contain flags rather than secrets. The release must pass scripts/scan-secrets.mjs.

Run npm run dist:mac and npm run smoke:package for runtime/packaging changes. Smokes use disposable profiles and must not make paid service calls. Distinguish unit checks, real service checks, owner feedback and actual audio verification in release notes.

The first release supports Apple Silicon Macs. Phone access, Windows/Intel packaging and additional hosted orchestration need separate acceptance work.
