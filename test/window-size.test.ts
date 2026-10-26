import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { windowSize, saveWindowSize } from "../app/window-size.js";
describe("desktop workspace size", () => {
  it("starts large, remembers resizing and fits the current display", () => {
    const home = mkdtempSync(path.join(tmpdir(), "jev-window-"));
    try {
      expect(windowSize(home, { width: 1440, height: 900 })).toEqual({ width: 1080, height: 800 });
      saveWindowSize(home, { width: 1200, height: 1000 });
      expect(windowSize(home, { width: 1024, height: 768 })).toEqual({ width: 992, height: 736 });
      saveWindowSize(home, { width: 440, height: 720 }); expect(windowSize(home, { width: 1440, height: 900 })).toEqual({ width: 440, height: 720 });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
