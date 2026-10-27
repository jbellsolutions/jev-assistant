import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
it.skipIf(process.platform !== "darwin")("preserves the former bundle on upgrade and never moves an unrelated app with the old name", () => {
  const root = mkdtempSync(path.join(tmpdir(), "Jarvis migration "));
  const old = path.join(root, "Applications", "Jev.app"), next = path.join(root, "Applications", "Jarvis.app");
  const plist = (id: string) => `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`;
  try {
    mkdirSync(path.join(old, "Contents"), { recursive: true }); mkdirSync(next, { recursive: true });
    writeFileSync(path.join(old, "Contents", "Info.plist"), plist("unrelated.user.app"));
    const run = () => execFileSync("/bin/sh", ["scripts/installer/postinstall", "", "", root]);
    run(); expect(existsSync(old)).toBe(true);
    writeFileSync(path.join(old, "Contents", "Info.plist"), plist("com.jev.app"));
    run(); expect(existsSync(old)).toBe(false); expect(existsSync(next)).toBe(true);
    const saved = path.join(root, "Library", "Application Support", "Jarvis", "Previous Versions");
    expect(readdirSync(saved)).toHaveLength(1); run(); expect(readdirSync(saved)).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
