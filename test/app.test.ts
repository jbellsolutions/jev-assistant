import { describe, expect, it } from "vitest";
import { TALK_IDLE, TAP_MS, onEscape, onHotkey, onPaused, onRendererBusy, onRendererSpeaking, onTalkKey, onWindowVisibility, type PanelState } from "../app/hotkey.js";
import { encodePng, trayAlpha, trayIconPng } from "../app/tray-icon.js";

describe("panel hotkey state machine", () => {
  it("⌥Space always shows and focuses; it never hides an already-visible panel", () => {
    expect(onHotkey({ visible: false, busy: false })).toEqual({ state: { visible: true, busy: false }, effects: ["show", "focus"] });
    expect(onHotkey({ visible: true, busy: false })).toEqual({ state: { visible: true, busy: false }, effects: ["focus"] });
    expect(onHotkey({ visible: true, busy: true })).toEqual({ state: { visible: true, busy: true }, effects: ["focus"] });
  });

  it("escape cancels while busy (stays open), else hides", () => {
    expect(onEscape({ visible: true, busy: true })).toEqual({ state: { visible: true, busy: true }, effects: ["cancel"] });
    expect(onEscape({ visible: true, busy: false })).toEqual({ state: { visible: false, busy: false }, effects: ["hide"] });
    expect(onEscape({ visible: false, busy: false }).effects).toEqual([]);
  });

  it("paused: the hotkey resumes and shows; pausing drops busy", () => {
    expect(onHotkey({ visible: true, busy: false, paused: true })).toEqual({ state: { visible: true, busy: false, paused: false }, effects: ["resume", "focus"] });
    expect(onHotkey({ visible: false, busy: false, paused: true }).effects).toEqual(["resume", "show", "focus"]);
    expect(onPaused({ visible: true, busy: true }, true)).toEqual({ visible: true, busy: false, paused: true });
    const s = { visible: true, busy: false, paused: true };
    expect(onPaused(s, true)).toBe(s);
    expect(onPaused(s, false)).toEqual({ visible: true, busy: false, paused: false });
  });

  it("follows what the renderer and window report", () => {
    const s = { visible: true, busy: false };
    expect(onRendererBusy(s, true)).toEqual({ visible: true, busy: true });
    expect(onRendererBusy(s, false)).toBe(s);
    expect(onWindowVisibility(s, false)).toEqual({ visible: false, busy: false });
  });
});

describe("tray icon: paused glyph", () => {
  it("is dimmer than idle and has a bar", () => {
    const idle = trayAlpha("idle", 44);
    const paused = trayAlpha("paused", 44);
    const sum = (a: Uint8Array) => a.reduce((n, v) => n + v, 0);
    expect(sum(paused)).toBeLessThan(sum(idle));
    // the bar: full coverage inside the ring's hole at the top centre, where the idle ring is empty
    expect(paused[12 * 44 + 21]).toBeGreaterThan(200);
    expect(idle[12 * 44 + 21]).toBe(0);
  });
});

describe("tray icon", () => {
  it("encodes a valid PNG with the right dimensions", () => {
    const png = trayIconPng("busy", 22);
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(22);
    expect(png.readUInt32BE(20)).toBe(22);
    expect(png.subarray(png.length - 8, png.length - 4).toString("ascii")).toBe("IEND");
  });

  it("idle and busy are both rings (transparent centre), busy's thicker", () => {
    expect(trayAlpha("idle", 21)[10 * 21 + 10]).toBe(0);
    expect(trayAlpha("busy", 21)[10 * 21 + 10]).toBe(0);
    expect(trayAlpha("idle", 21)[10 * 21 + 2]).toBe(255); // on the ring
    expect(trayAlpha("idle", 21)[0]).toBe(0); // corner
    const tiny = encodePng(1, 1, new Uint8Array([0, 0, 0, 255]));
    expect(tiny.length).toBeGreaterThan(40);
  });
});

describe("being told to be quiet", () => {
  it("cuts the voice off first, and leaves the panel and the work alone", () => {
    // In wake mode the microphone is deaf while she talks, so saying "stop" cannot reach her until
    // she has stopped. A keystroke is the only way out of a long answer, and it must not also hide
    // the panel or abandon what she was doing.
    const { state, effects } = onEscape({ visible: true, busy: true, speaking: true });
    expect(effects).toEqual(["hush"]);
    expect(state.visible).toBe(true);
    expect(state.speaking).toBe(false);
  });

  it("still cancels, and still hides, once she has stopped talking", () => {
    expect(onEscape({ visible: true, busy: true }).effects).toEqual(["cancel"]);
    expect(onEscape({ visible: true, busy: false }).effects).toEqual(["hide"]);
  });

  it("interrupts from a hidden panel with the hotkey, and shows it", () => {
    // The real case: she is reading an answer across the room with the panel tucked away.
    const { state, effects } = onHotkey({ visible: false, busy: false, speaking: true });
    expect(effects).toEqual(["hush", "show", "focus"]);
    expect(state.speaking).toBe(false);
    expect(state.visible).toBe(true);
  });

  it("takes the renderer's word for whether she is talking", () => {
    const quiet: PanelState = { visible: true, busy: false };
    expect(onRendererSpeaking(quiet, true).speaking).toBe(true);
    expect(onRendererSpeaking(quiet, false)).toBe(quiet); // unchanged object: no needless re-render
  });
});

describe("the talk key (Fn+Control)", () => {
  it("hold: listens while held and sends on release", () => {
    let r = onTalkKey(TALK_IDLE, "down", 1000);
    expect(r.effects).toEqual(["start"]);
    r = onTalkKey(r.state, "up", 3000);
    expect(r.effects).toEqual(["stop"]);
    expect(r.state).toEqual(TALK_IDLE);
  });

  it("tap: stays listening hands-free until the next tap, whose release starts nothing", () => {
    let r = onTalkKey(TALK_IDLE, "down", 1000);
    r = onTalkKey(r.state, "up", 1000 + TAP_MS - 50);
    expect(r.effects).toEqual([]);
    expect(r.state.phase).toBe("handsfree");
    r = onTalkKey(r.state, "down", 9000);
    expect(r.effects).toEqual(["stop"]);
    r = onTalkKey(r.state, "up", 9100);
    expect(r.effects).toEqual([]);
    expect(r.state).toEqual(TALK_IDLE);
  });

  it("cuts Jev off first when she is talking, then listens", () => {
    expect(onTalkKey(TALK_IDLE, "down", 0, true).effects).toEqual(["hush", "start"]);
  });

  it("a shortcut (another key while held) closes the microphone without sending anything", () => {
    const r = onTalkKey(onTalkKey(TALK_IDLE, "down", 0).state, "cancel", 500);
    expect(r.effects).toEqual(["abort"]);
    expect(r.state).toEqual(TALK_IDLE);
  });
});
