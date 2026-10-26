import { describe, expect, it } from "vitest";
import { STT_FINISH_TIMEOUT_MS } from "../../../core/protocol.ts";
import { Outbox, STOP_FLUSH_MS } from "./outbox.ts";

const buf = (n: number) => new Uint8Array([n]).buffer;
const log = () => {
  const sent: Array<string | number> = [];
  return { sent, send: (d: ArrayBuffer | string) => sent.push(typeof d === "string" ? JSON.parse(d).type : new Uint8Array(d)[0]!) };
};

describe("the microphone outbox", () => {
  it("keeps the first words: frames recorded before the socket opened follow the start", () => {
    const l = log();
    const o = new Outbox(l.send);
    o.frame(buf(1));
    o.frame(buf(2));
    expect(l.sent).toEqual([]);
    o.open(JSON.stringify({ type: "start" }));
    o.frame(buf(3));
    expect(l.sent).toEqual(["start", 1, 2, 3]);
  });

  it("a key released before the socket opened still ends the utterance", () => {
    const l = log();
    const o = new Outbox(l.send);
    o.frame(buf(1));
    o.stop();
    o.frame(buf(9)); // after release: not part of it
    o.open(JSON.stringify({ type: "start" }));
    expect(l.sent).toEqual(["start", 1, "stop"]);
  });

  it("stops once, and bounds what it holds", () => {
    const l = log();
    const o = new Outbox(l.send, 2);
    o.frame(buf(1));
    o.frame(buf(2));
    o.frame(buf(3));
    expect(o.queued).toBe(2);
    o.open(JSON.stringify({ type: "start" }));
    o.stop();
    o.stop();
    expect(l.sent).toEqual(["start", 2, 3, "stop"]);
  });

  it("holds the socket past the relay's own flush", () => {
    expect(STOP_FLUSH_MS).toBeGreaterThan(STT_FINISH_TIMEOUT_MS);
  });
});
