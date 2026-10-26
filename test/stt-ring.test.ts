import { describe, expect, it } from "vitest";
import { PcmRing, bytesForSeconds } from "../server/stt/ring.js";

const frame = (n: number, byte: number) => new Uint8Array(n).fill(byte);

describe("the wake-mode audio buffer", () => {
  it("keeps the most recent audio and drops the oldest", () => {
    const ring = new PcmRing(300);
    ring.push(frame(100, 1));
    ring.push(frame(100, 2));
    ring.push(frame(100, 3));
    ring.push(frame(100, 4));
    expect(ring.drain().map((c) => c[0])).toEqual([2, 3, 4]);
  });

  it("drops whole frames, never half of one", () => {
    // A frame is 100ms of 16-bit samples; slicing mid-frame hands the provider a torn sample.
    const ring = new PcmRing(150);
    ring.push(frame(100, 1));
    ring.push(frame(100, 2));
    const held = ring.drain();
    for (const c of held) expect(c.byteLength).toBe(100);
  });

  it("never empties itself completely, so a single oversized frame still survives", () => {
    const ring = new PcmRing(10);
    ring.push(frame(500, 9));
    expect(ring.drain().map((c) => c[0])).toEqual([9]);
  });

  it("is empty after draining", () => {
    const ring = new PcmRing(1000);
    ring.push(frame(10, 1));
    expect(ring.drain()).toHaveLength(1);
    expect(ring.drain()).toEqual([]);
    expect(ring.size).toBe(0);
  });

  it("sizes itself in real seconds at the client's sample rate", () => {
    // The client sends mono pcm_s16le at 16 kHz (client/src/hooks/useStreamingTranscription.ts).
    expect(bytesForSeconds(1, 16000)).toBe(32_000);
    expect(bytesForSeconds(8, 16000)).toBe(256_000);
  });
});
