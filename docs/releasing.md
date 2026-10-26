# Building and releasing Jev

## Local preview build

Use an Apple Silicon Mac and Node 22. Install Xcode Command Line Tools for Swift helper builds.

```sh
npm ci
npm run build:keys
npm run build:audio-out
npm run check
npm run release:mac
npm run smoke:package
```

The release directory contains the standard Mac `.pkg`, a quick-start guide and SHA256SUMS.txt. The package installs Jev.app and the separately signed CuaDriver.app in Applications. Driver version 0.28.2 is fetched from the official vendor release with a pinned SHA-256 and its code signature verified. A component's newer installed version is not downgraded. Existing private settings/tasks live in the user's home directory.

The installer is built for Apple Silicon only. Do not relabel it as universal or Windows-compatible.

## Apple signing for a general release

The preview was built without an Apple Developer identity. Before promising a normal warning-free install:

1. Install your **Developer ID Application** and **Developer ID Installer** certificates in the build Mac's keychain. Keep certificates/passwords out of the repository.
2. Let electron-builder select the Application identity, or set `CSC_NAME` to the intended identity. Do not set `CSC_IDENTITY_AUTO_DISCOVERY=false` for the signed build.
3. Set `APPLE_INSTALLER_IDENTITY` to the Developer ID Installer identity.
4. Store Apple notarization credentials with `xcrun notarytool store-credentials`, using a private keychain profile. Set `APPLE_NOTARY_PROFILE` to that profile's name.
5. Run the release build. It signs the app, signs the installer, submits the package for notarization, waits, and staples the result.
6. Check the notarized package with Apple's tools and install it on a clean physical Mac. Do not claim notarization from a successful unsigned build.

Signing guide: [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing).

## GitHub

The CI workflow checks and builds on an Apple Silicon macOS runner, then uploads unsigned preview artifacts. It intentionally has no provider keys or account credentials. Public GitHub-hosted runner labels and architecture are documented by [GitHub](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

Before publishing a release:

- Run the checks and relocated package smoke locally.
- Run the source secret scan and inspect the Git index. Exclude private notes, runtime data, paired extension config and credentials.
- Verify the installer payload and checksums.
- Upload the package, START-HERE.md and SHA256SUMS.txt to a clearly labeled preview release until signing is complete.
- Publish future signed artifacts as a new version; do not silently replace binaries under an existing checksum.

No API keys, browser cookies, local pairing tokens, provider profiles, or Mac privacy grants are part of a distributable build. Users supply their own accounts.
