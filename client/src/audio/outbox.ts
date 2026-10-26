/** What the microphone socket sends, in the order the relay needs it: `start`, then every frame
 *  recorded so far, then `stop`.
 *
 *  Holding Fn+Control starts the microphone and opens the socket at the same moment, and the socket
 *  takes a beat to open. Dropping frames until it does lost the first words ("send Abdul…" arrived
 *  as "…Abdul"), and releasing the key before it opened lost the `stop` too. So frames wait here,
 *  and a stop asked for early is sent once the socket catches up. */
import { STT_FINISH_TIMEOUT_MS } from "../../../core/protocol.ts";

/** How long the panel keeps the socket after `stop`: past the relay's own guard, so its last flush
 *  always lands before the panel lets go. */
export const STOP_FLUSH_MS = STT_FINISH_TIMEOUT_MS + 1500;

/** ~15s of 100ms frames: a stuck socket cannot grow memory without bound. */
const MAX_QUEUED = 150;

export class Outbox {
  private queue: ArrayBuffer[] = [];
  private opened = false;
  private stopAsked = false;

  constructor(
    private readonly send: (data: ArrayBuffer | string) => void,
    private readonly max = MAX_QUEUED,
  ) {}

  frame(data: ArrayBuffer): void {
    if (this.stopAsked) return; // released: nothing after the key goes up belongs to this utterance
    if (this.opened) return this.send(data);
    this.queue.push(data);
    if (this.queue.length > this.max) this.queue.shift();
  }

  /** The socket opened: start the stream, replay what was recorded while it opened, and pass on a
   *  stop that was asked for in the meantime. */
  open(start: string): void {
    this.send(start);
    for (const f of this.queue.splice(0)) this.send(f);
    this.opened = true;
    if (this.stopAsked) this.send(JSON.stringify({ type: "stop" }));
  }

  stop(): void {
    if (this.stopAsked) return;
    this.stopAsked = true;
    if (this.opened) this.send(JSON.stringify({ type: "stop" }));
  }

  get queued(): number {
    return this.queue.length;
  }
}
