import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OutputDevice, deviceReader } from "../server/speak/device.js";

describe("the output device Jev's voice goes to", () => {
  it("reads the helper's one line", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jev-device-"));
    const bin = path.join(dir, "jev-audio-out");
    writeFileSync(bin, "#!/bin/sh\necho 'Soundcore Headphones'\n");
    chmodSync(bin, 0o755);
    expect(await deviceReader(bin)()).toBe("Soundcore Headphones");
  });

  it("is null, not a wrong name, when the helper is missing or fails", async () => {
    expect(await deviceReader("/nonexistent/jev-audio-out")()).toBeNull();
    expect(await deviceReader("/usr/bin/false")()).toBeNull();
  });

  it("reports a change once, and only when it changes", async () => {
    let now: string | null = "Soundcore Headphones";
    const changes: Array<string | null> = [];
    const d = new OutputDevice(async () => now, (v) => changes.push(v));
    await d.refresh();
    await d.refresh();
    now = "Mac mini Speakers";
    await d.refresh();
    expect(changes).toEqual(["Soundcore Headphones", "Mac mini Speakers"]);
    expect(d.current).toBe("Mac mini Speakers");
  });

  it("survives a reader that throws", async () => {
    const d = new OutputDevice(async () => {
      throw new Error("boom");
    });
    expect(await d.refresh()).toBeNull();
  });
});
