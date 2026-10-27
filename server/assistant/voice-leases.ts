import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
/** Only room IDs created by this installation. No tokens, audio or transcript content. */
export class VoiceLeases {
  private rooms = new Set<string>();
  private file: string;
  constructor(home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 }); this.file = path.join(home, "voice-rooms.json");
    try { const rows: unknown = JSON.parse(readFileSync(this.file, "utf8")); if (!Array.isArray(rows)) throw new Error(); for (const room of rows) if (typeof room === "string" && /^jev-[a-f0-9-]{36}$/.test(room)) this.rooms.add(room); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Saved voice recovery data could not be read. Review private voice-rooms.json before starting another call."); }
  }
  list() { return [...this.rooms]; }
  add(room: string) { this.rooms.add(room); this.save(); }
  remove(room: string) { this.rooms.delete(room); this.save(); }
  private save() { writeFileSync(`${this.file}.tmp`, JSON.stringify(this.list()), { mode: 0o600 }); renameSync(`${this.file}.tmp`, this.file); }
}
