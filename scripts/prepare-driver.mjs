/** Fetch the signed, pinned Cua Driver app; never copy a user's installed bundle. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Phase 1 installer is built on an Apple Silicon Mac");
export const version = "0.28.2";
const name = `cua-driver-rs-${version}-darwin-arm64.tar.gz`;
const expected = "818ddefa0fa8ba2ec9cba837c7aa634a4b064221c748752cf49c5b08e2c94e8c";
const dir = `${root}/build/vendor`; mkdirSync(dir, { recursive: true });
const archive = `${dir}/${name}`;
if (!existsSync(archive)) {
  const r = await fetch(`https://github.com/trycua/cua/releases/download/cua-driver-rs-v${version}/${name}`);
  if (!r.ok) throw new Error(`Driver download failed: ${r.status}`);
  writeFileSync(archive, Buffer.from(await r.arrayBuffer()));
}
if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== expected) throw new Error("Driver checksum mismatch; refusing to package");
const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n");
if (entries.some((s) => s.startsWith("/") || s.split("/").includes(".."))) throw new Error("Unsafe archive path");
execFileSync("tar", ["-xzf", archive, "-C", dir]);
const source = `${dir}/cua-driver-rs-${version}-darwin-arm64/CuaDriver.app`;
execFileSync("codesign", ["--verify", "--deep", "--strict", source], { stdio: "inherit" });
const app = `${dir}/CuaDriver.app`; rmSync(app, { recursive: true, force: true });
cpSync(source, app, { recursive: true, verbatimSymlinks: true });
console.log(`Prepared checksum-verified Cua Driver ${version}`);
