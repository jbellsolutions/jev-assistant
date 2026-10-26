import { describe, expect, it } from "vitest";
import { NOT_CONNECTED, SystemBrowser } from "../server/executors/system-browser.js";

describe("the browser fallback when Chrome isn't connected", () => {
  it("opens pages and searches where the user can see them", async () => {
    const opened: string[] = [];
    const b = new SystemBrowser(async (u) => void opened.push(u));
    expect(await b.execute({ kind: "navigate", url: "https://en.wikipedia.org" })).toBe("Opened https://en.wikipedia.org in your browser");
    expect(await b.execute({ kind: "search", query: "cats", url: "https://www.google.com/search?q=cats" })).toMatch(/Searched for "cats"/);
    expect(opened).toEqual(["https://en.wikipedia.org", "https://www.google.com/search?q=cats"]);
  });

  it("refuses to pretend: clicking or typing says the bridge is off, instead of acting somewhere hidden", async () => {
    const b = new SystemBrowser(async () => {});
    await expect(b.execute({ kind: "click", elementId: "e0", label: "Pricing" })).rejects.toThrow(NOT_CONNECTED);
    await expect(b.execute({ kind: "type", elementId: null, label: null, text: "hi", submit: false })).rejects.toThrow(NOT_CONNECTED);
    expect(b.capabilities.read).toBe(false);
    expect(b.readHint).toBe(NOT_CONNECTED);
  });
});
