/** Standard macOS Installer package: Jarvis + the signed Mac-control helper. No shell for users. */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import "./prepare-driver.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const version = JSON.parse(readFileSync(`${root}/package.json`, "utf8")).version;
const out = `${root}/release`; const staging = `${root}/build/installer-root`;
rmSync(staging, { recursive: true, force: true }); mkdirSync(`${staging}/Applications`, { recursive: true }); mkdirSync(out, { recursive: true });
for (const [source, name] of [[`${root}/dist-electron/mac-arm64/Jarvis.app`, "Jarvis.app"], [`${root}/build/vendor/CuaDriver.app`, "CuaDriver.app"]]) cpSync(source, `${staging}/Applications/${name}`, { recursive: true, verbatimSymlinks: true });
const components = `${root}/build/installer-components.plist`;
execFileSync("pkgbuild", ["--analyze", "--root", staging, components]);
const count = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", components], { encoding: "utf8" })).length;
for (let i = 0; i < count; i++) {
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${i}:BundleIsRelocatable false`, components]);
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${i}:BundleIsVersionChecked true`, components]);
}
const pkg = `${out}/Jarvis-${version}-mac-arm64.pkg`;
const unsigned = `${out}/Jarvis-${version}-mac-arm64-unsigned.pkg`;
execFileSync("pkgbuild", ["--root", staging, "--component-plist", components, "--scripts", `${root}/scripts/installer`, "--identifier", "com.jev.installer", "--version", version, "--install-location", "/", unsigned], { stdio: "inherit" });
if (process.env.APPLE_INSTALLER_IDENTITY) execFileSync("productsign", ["--sign", process.env.APPLE_INSTALLER_IDENTITY, unsigned, pkg], { stdio: "inherit" });
else { cpSync(unsigned, pkg); console.log("Preview package: no Apple Installer identity configured."); }
rmSync(unsigned, { force: true });
if (process.env.APPLE_NOTARY_PROFILE) {
  execFileSync("xcrun", ["notarytool", "submit", pkg, "--keychain-profile", process.env.APPLE_NOTARY_PROFILE, "--wait"], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "staple", pkg], { stdio: "inherit" });
}
cpSync(`${root}/docs/start-here.md`, `${out}/START-HERE.md`);
writeFileSync(`${out}/SHA256SUMS.txt`, `${createHash("sha256").update(readFileSync(pkg)).digest("hex")}  ${pkg.split("/").at(-1)}\n`);
rmSync(staging, { recursive: true, force: true });
console.log(`Installer ready: ${pkg}`);
