/** Where Jev's voice actually comes out: the Mac's default output device, by name.
 *
 *  Why this exists: ffplay plays to whatever macOS output is selected, so when the default drifted to
 *  "Mac mini Speakers" Jev's voice went there and the headset was silent — and nothing on screen said
 *  so. The panel names the device beside the voice, so "no sound in my headset" is visible at a glance.
 *
 *  Read-only. Jev never switches the output; the Mac's own Sound setting stays in charge. */
import { execFile } from "node:child_process";

/** How often the device is re-read. A spawn of a ~10ms binary; the panel updates within this. */
export const DEVICE_POLL_MS = 10_000;

export type ReadDevice = () => Promise<string | null>;

/** Reads the device through native/jev-audio-out. Null when the helper is missing or fails — the
 *  pill then simply shows no device rather than a wrong one. */
export function deviceReader(bin: string): ReadDevice {
  return () =>
    new Promise((resolve) => {
      execFile(bin, [], { timeout: 3_000 }, (err, stdout) => {
        const name = String(stdout ?? "").trim();
        resolve(err || !name ? null : name);
      });
    });
}

/** Holds the last-read device and tells a listener when it changes. */
export class OutputDevice {
  private value: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly read: ReadDevice,
    private readonly onChange: (device: string | null) => void = () => {},
  ) {}

  get current(): string | null {
    return this.value;
  }

  /** Reads once now; reports a change (including the first successful read). */
  async refresh(): Promise<string | null> {
    const next = await this.read().catch(() => null);
    if (next !== this.value) {
      this.value = next;
      this.onChange(next);
    }
    return next;
  }

  start(everyMs = DEVICE_POLL_MS): this {
    if (!this.timer) {
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), everyMs);
      this.timer.unref?.();
    }
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
