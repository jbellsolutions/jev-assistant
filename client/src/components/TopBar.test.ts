import { describe, expect, it } from "vitest";
import { voiceTitle } from "./TopBar.tsx";

describe("the voice pill's tooltip", () => {
  it("says where the voice plays and where to change it", () => {
    expect(voiceTitle({ on: true, detail: "fish (x)", device: "Mac mini Speakers" })).toMatch(/Playing through: Mac mini Speakers.*Sound/);
  });

  it("is just the voice when the device is unknown", () => {
    expect(voiceTitle({ on: true, detail: "fish (x)", device: null })).toBe("fish (x)");
  });
});

describe("voicePill", () => {
  it("says muted first, since that is why she is quiet", async () => {
    const { voicePill } = await import("./TopBar.tsx");
    expect(voicePill({ on: true, detail: "fish (s2)", device: "Soundcore", muted: true })).toBe("🔇 muted");
    expect(voicePill({ on: true, detail: "fish (s2)", device: "Soundcore", muted: false })).toBe("🔊 fish → Soundcore");
    expect(voicePill({ on: false, detail: "off" })).toBe("🔇 no voice");
    expect(voicePill({ on: false, detail: "GPT-Live 1 via LiveKit" })).toBe("◉ Live voice idle");
  });
});

describe("bridgeWarning", () => {
  it("speaks up only for an older extension, and says how to fix it", async () => {
    const { bridgeWarning } = await import("./TopBar.tsx");
    expect(bridgeWarning(null)).toBeNull();
    expect(bridgeWarning({ protocol: 4, current: 4 })).toBeNull();
    expect(bridgeWarning({ protocol: 2, current: 4 })).toMatch(/v2.*v4.*Reload.*jev\/dist\/extension/);
  });
});
