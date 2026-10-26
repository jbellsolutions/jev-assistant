import { describe, expect, it } from "vitest";
import { CONTROLS_MIN, PANE_KEY, PANE_MIN, clampPane, frameFraction, keystroke, loadPaneHeight, savePaneHeight, stepZoom } from "./layout.ts";

describe("the divider", () => {
  it("keeps both halves usable", () => {
    expect(clampPane(50, 900)).toBe(PANE_MIN);
    expect(clampPane(5000, 900)).toBe(900 - CONTROLS_MIN);
    expect(clampPane(420.4, 900)).toBe(420);
    expect(clampPane(300, 250)).toBe(PANE_MIN); // a tiny window still shows a pane
  });

  it("remembers the size, and survives storage that throws", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    savePaneHeight(store, 333.6);
    expect(m.get(PANE_KEY)).toBe("334");
    expect(loadPaneHeight(store)).toBe(334);
    savePaneHeight(store, null);
    expect(loadPaneHeight(store)).toBeNull();
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => {} };
    expect(loadPaneHeight(broken)).toBeNull();
    expect(() => savePaneHeight(broken, 100)).not.toThrow();
    expect(loadPaneHeight(undefined)).toBeNull();
  });
});

describe("a click on the picture", () => {
  const natural = { width: 1200, height: 800 };
  it("is a fraction of the picture, not of the box around it", () => {
    // a tall box: the 1200×800 picture is scaled to 600×400 and pinned top-left
    const box = { left: 10, top: 20, width: 600, height: 900 };
    expect(frameFraction({ x: 310, y: 220 }, box, natural)).toEqual({ fx: 0.5, fy: 0.5 });
    expect(frameFraction({ x: 310, y: 700 }, box, natural)).toBeNull(); // below the picture
    // a wide box: scaled by height
    expect(frameFraction({ x: 150, y: 100 }, { left: 0, top: 0, width: 1000, height: 200 }, natural)).toEqual({ fx: 0.5, fy: 0.5 });
    expect(frameFraction({ x: 400, y: 100 }, { left: 0, top: 0, width: 1000, height: 200 }, natural)).toBeNull();
  });
});

describe("typing on the picture", () => {
  const k = (key: string, m: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => keystroke({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });
  it("types characters and sends named keys and shortcuts", () => {
    expect(k("a")).toEqual({ text: "a" });
    expect(k("A", { shiftKey: true })).toEqual({ text: "A" });
    expect(k(" ")).toEqual({ text: " " });
    expect(k("Enter")).toEqual({ key: "Enter" });
    expect(k("a", { metaKey: true })).toEqual({ key: "cmd+a" });
    expect(k("Enter", { shiftKey: true })).toEqual({ key: "shift+Enter" });
    expect(k("Shift", { shiftKey: true })).toBeNull();
    expect(k("F13")).toBeNull();
  });
});

describe("zoom", () => {
  it("steps through the levels from fit", () => {
    expect(stepZoom("fit", 1)).toBe(1.25);
    expect(stepZoom("fit", -1)).toBe(0.8);
    expect(stepZoom(2, 1)).toBe(2);
    expect(stepZoom(0.5, -1)).toBe(0.5);
    expect(stepZoom(0.9, 1)).toBe(1);
  });
});

describe("the co-founder's desktop at a zoom", () => {
  it("fills the pane at fit, and is the remote screen's size times each step otherwise", async () => {
    const { vncBox, stepZoom } = await import("./layout.ts");
    const fb = { width: 1280, height: 720 };
    expect(vncBox("fit", fb)).toBeNull();
    let z: number = stepZoom("fit", 1);
    const widths: number[] = [];
    for (let i = 0; i < 3; i++) {
      widths.push(vncBox(z, fb)!.width);
      z = stepZoom(z, 1);
    }
    expect(new Set(widths).size).toBe(3); // every + step changes the size (it used to stop after one)
    expect(vncBox(0.5, fb)).toEqual({ width: 640, height: 360 });
    expect(vncBox(1, null)).toEqual({ width: 1280, height: 720 }); // before the first frame: Orgo's 1280×720
  });
});
