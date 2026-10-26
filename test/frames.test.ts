import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "../core/protocol.js";
import { FRAME_HEARTBEAT_MS, FrameStreamer } from "../server/hub.js";

function surface(shots: Array<Uint8Array | null>, problem = "Nothing in front but Jev's own windows") {
  return {
    capabilities: { screenshot: true },
    url: "app://Finder",
    frameProblem: problem,
    async title() { return "realtor-leads"; },
    async screenshot() { return shots.length > 1 ? shots.shift()! : shots[0]!; },
  } as never;
}

describe("the frame loop says when the picture is not live (v11.5)", () => {
  afterEach(() => vi.useRealTimers());

  it("reports a missing picture once, with the reason, instead of silently keeping the old one", async () => {
    const sent: ServerMessage[] = [];
    const s = new FrameStreamer(surface([null]), (m) => sent.push(m), 700);
    s.clients = 1;
    await s.push();
    await s.push();
    expect(sent).toEqual([{ type: "frame_status", ok: false, reason: "Nothing in front but Jev's own windows", at: expect.any(Number) }]);
  });

  it("resends an unchanged picture on the heartbeat, stamped, so still and stuck look different", async () => {
    vi.useFakeTimers();
    const sent: ServerMessage[] = [];
    const s = new FrameStreamer(surface([new Uint8Array([9])]), (m) => sent.push(m), 700);
    s.clients = 1;
    await s.push();
    await s.push(); // same picture, too soon: skipped
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(FRAME_HEARTBEAT_MS);
    await s.push();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ type: "screenshot", url: "app://Finder", at: expect.any(Number) });
  });
});
