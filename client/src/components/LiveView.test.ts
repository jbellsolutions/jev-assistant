import { describe, expect, it } from "vitest";
import { type State, initialState, paneForTool, reducer } from "../state.ts";
import { LIVE_MS, freshness } from "../layout.ts";

describe("\"Your screen\" says whether its picture is live (v11.5)", () => {
  const page = { url: "app://Finder", title: "realtor-leads", frame: "data:image/jpeg;base64,AA==" };

  it("is live while frames keep arriving, and says how old the last one is once they stop", () => {
    expect(freshness({ ...page, at: 1000 }, 1000 + LIVE_MS - 1)).toEqual({ live: true, text: "Live" });
    expect(freshness({ ...page, at: 1000 }, 1000 + 120_000)).toEqual({ live: false, text: "Not live — last picture 2m ago" });
  });

  it("names the reason the server gave, and clears it when a new frame arrives", () => {
    let s = reducer(initialState, { type: "screenshot", jpegBase64: "AA==", url: page.url, title: page.title, at: 1000 });
    s = reducer(s, { type: "frame_status", ok: false, reason: "Nothing in front but Jev's own windows", at: 2000 });
    expect(freshness(s.page, 2500)).toEqual({ live: false, text: "Not live — last picture 2s ago (Nothing in front but Jev's own windows)" });
    s = reducer(s, { type: "screenshot", jpegBase64: "AA==", url: page.url, title: page.title, at: 3000 });
    expect(freshness(s.page, 3500).live).toBe(true);
  });

  it("keeps the pane where it is while Jev works in its own background Chrome, and says where", () => {
    expect(paneForTool("chrome", '{"action":"navigate","url":"https://login.salesforce.com"}')).toBeNull();
    expect(paneForTool("chrome", '{"action":"read_text","tab":"his_tab"}')).toBe("screen");
    expect(paneForTool("mac_read", '{"app":"Finder"}')).toBe("screen");
    let s: State = { ...initialState, pane: { tab: "browser", manual: false, runId: null } };
    s = reducer(s, { type: "brain_event", stepId: 1, runId: "r1", event: { kind: "tool_start", tool: "chrome", preview: '{"action":"navigate","url":"https://login.salesforce.com"}' } });
    expect(s.pane.tab).toBe("browser");
    expect(s.jevChrome).toMatchObject({ action: "navigate", url: "https://login.salesforce.com" });
    s = reducer(s, { type: "brain_event", stepId: 1, runId: "r1", event: { kind: "completed", output: "done" } });
    expect(s.jevChrome).toBeNull();
  });
});
