import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { KEEP_WHOLE, OLD_SCREEN_CHARS, compactScreens, shortenScreen } from "../server/brain/compact.js";

const screen = (n: number) => `Clicked row ${n}\n\nNow:\nSlack — app://Slack\n${Array.from({ length: 300 }, (_, i) => `e${i} button "Item ${i}"`).join("\n")}\nText on screen:\nAbdul: meeting at ${n}`;
const result = (name: string, value: string, id: string): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: name, output: { type: "text", value } }] });
const textOf = (m: ModelMessage) => (m.role === "tool" && m.content[0]!.type === "tool-result" && m.content[0]!.output.type === "text" ? m.content[0]!.output.value : "");

describe("keeping the brain's history short", () => {
  it("keeps what was done and what was on screen, and drops the element list", () => {
    const s = shortenScreen(screen(1));
    expect(s).toMatch(/^Clicked row 1\nText on screen:\nAbdul: meeting at 1/);
    expect(s).not.toContain('e5 button "Item 5"');
    expect(s.length).toBeLessThan(OLD_SCREEN_CHARS + 120);
    expect(shortenScreen(s)).toBe(s); // idempotent: the override carries forward every step
  });

  it("shortens all but the latest screens, and leaves other tools alone", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "check slack" },
      result("mac_read", screen(1), "a"),
      result("shell", "x".repeat(5000), "b"),
      result("mac_act", screen(2), "c"),
      result("mac_act", screen(3), "d"),
      result("mac_act", screen(4), "e"),
    ];
    const out = compactScreens(msgs);
    expect(out).not.toBe(msgs);
    expect(textOf(out[1]!)).toContain("shortened");
    expect(textOf(out[2]!)).toHaveLength(5000);
    expect(textOf(out[3]!)).toContain("shortened");
    // the latest KEEP_WHOLE stay whole
    expect(KEEP_WHOLE).toBe(2);
    expect(textOf(out[4]!)).toBe(screen(3));
    expect(textOf(out[5]!)).toBe(screen(4));
    expect(textOf(out[1]!).length).toBeLessThan(screen(1).length / 5);
    expect(compactScreens(out)).toBe(out); // nothing more to do: same array
  });
});
