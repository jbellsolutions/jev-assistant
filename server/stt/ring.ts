/** A fixed-size ring of recent PCM, so the audio before "Hey Jev" is not lost.
 *
 *  Why this has to exist. In wake mode Apple listens continuously (free, on-device, and the room's
 *  audio never leaves the Mac), but the COMMAND is transcribed by Scribe, which is the engine
 *  v7/M0 moved the user to for accuracy. When someone says the whole thing in one breath — "Hey Jev,
 *  turn Spotify down" — the command's audio has already gone past by the time the wake word is
 *  recognised. Without a buffer, that form simply cannot work, and the two-turn form ("Hey Jev" →
 *  "Yes?" → the command) would be the only one.
 *
 *  Sized in bytes rather than seconds so it holds regardless of sample rate; the relay converts. */
export class PcmRing {
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    // drop whole chunks from the front: a frame is 100ms, so the imprecision is never audible and
    // slicing mid-frame would hand the provider a torn sample
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()!.byteLength;
    }
  }

  /** Everything held, oldest first. */
  drain(): Uint8Array[] {
    const out = this.chunks.slice();
    this.clear();
    return out;
  }

  clear(): void {
    this.chunks.length = 0;
    this.bytes = 0;
  }

  get size(): number {
    return this.bytes;
  }
}

/** Seconds of 16-bit mono audio at `sampleRate`, in bytes. */
export function bytesForSeconds(seconds: number, sampleRate: number): number {
  return Math.ceil(seconds * sampleRate * 2);
}
