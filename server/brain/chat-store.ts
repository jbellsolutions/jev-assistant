/** the user's one ongoing chat with Jev, kept on disk so it outlives a restart. It ends only when he
 *  says so ("new chat", or the panel's New chat button) — his choice, 2026-09-26. Before this the
 *  brain's memory lived in the process: every relaunch, every cancelled run, and every second model
 *  error in a row quietly started a new conversation.
 *
 *  The whole chat is kept (up to MAX_KEPT turns); only the latest part is sent to the model. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ChatTurn {
  user: string;
  assistant: string;
  at: string;
  /** "action" for something Jev did straight away (open an app, a click) rather than a brain answer. */
  kind?: "brain" | "action";
}

export interface Chat {
  id: string;
  startedAt: string;
  turns: ChatTurn[];
}

const MAX_KEPT = 200;
const MAX_TURN_CHARS = 4_000;

export function defaultChatFile(): string {
  return path.join(homedir(), ".jev", "chat.json");
}

const newChat = (now: Date): Chat => ({ id: `chat_${now.getTime().toString(36)}`, startedAt: now.toISOString(), turns: [] });

export class ChatStore {
  private current: Chat;
  /** Bumped by every reset. A run remembers the generation it started in, so a run still finishing
   *  after "new chat" can't write its turn into the chat that replaced it. (Not the id: two chats
   *  made in the same millisecond share one.) */
  private gen = 0;

  /** `file: null` keeps the chat in memory only (tests, and a Jev with nowhere to write). */
  constructor(
    private readonly file: string | null = defaultChatFile(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.current = this.load() ?? newChat(this.now());
  }

  get chat(): Chat {
    return this.current;
  }

  get generation(): number {
    return this.gen;
  }

  /** `generation`: the chat the turn belongs to; a turn for a chat already closed is dropped. */
  append(user: string, assistant: string, kind: ChatTurn["kind"] = "brain", generation = this.gen): void {
    if (generation !== this.gen) return;
    const clip = (s: string) => (s.length > MAX_TURN_CHARS ? `${s.slice(0, MAX_TURN_CHARS)}…` : s);
    this.current.turns.push({ user: clip(user), assistant: clip(assistant), at: this.now().toISOString(), kind });
    if (this.current.turns.length > MAX_KEPT) this.current.turns.splice(0, this.current.turns.length - MAX_KEPT);
    this.save();
  }

  /** "new chat": the old one is gone from the model's view (and from disk). */
  reset(): Chat {
    this.gen++;
    this.current = newChat(this.now());
    this.save();
    return this.current;
  }

  /** The latest turns that fit both caps, oldest first. */
  recent(maxTurns: number, maxChars: number): ChatTurn[] {
    const out: ChatTurn[] = [];
    let chars = 0;
    for (const turn of [...this.current.turns].reverse()) {
      if (out.length >= maxTurns) break;
      chars += turn.user.length + turn.assistant.length;
      if (chars > maxChars) break;
      out.unshift(turn);
    }
    return out;
  }

  private load(): Chat | null {
    if (!this.file || !existsSync(this.file)) return null;
    try {
      const c = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Chat>;
      if (typeof c.id !== "string" || !Array.isArray(c.turns)) return null;
      const turns = c.turns.filter((t): t is ChatTurn => !!t && typeof t.user === "string" && typeof t.assistant === "string");
      return { id: c.id, startedAt: typeof c.startedAt === "string" ? c.startedAt : this.now().toISOString(), turns };
    } catch {
      return null; // unreadable: start a new chat rather than refuse to run
    }
  }

  /** tmp + rename, mode 0600: the chat can hold anything he said. */
  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.current), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      /* a full disk shouldn't stop Jev answering; the chat just isn't saved this turn */
    }
  }
}
