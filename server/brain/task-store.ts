/** The task the lead is working on: what the user asked for, what has been learned, and every job the
 *  worker has done for it. It outlives a single run, so a nudge ("you're on the right page — create
 *  a new one") continues the task instead of starting from nothing.
 *
 *  Live 2026-09-28: the user's Salesforce request took seven runs. Each started from the text of the
 *  earlier replies only — the real org host, the working Setup URL and which tab it was in were all
 *  lost between runs, so it guessed hostnames and landed on error pages. This is where those facts
 *  now live.
 *
 *  One task is open at a time: `~/.jev/task.json`. A closed task is moved to `~/.jev/tasks/<id>.json`
 *  for the record. Secrets are never stored here — only their handles. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface TaskJob {
  goal: string;
  status: JobStatus;
  /** The worker's own account of what it did and found, clipped. */
  summary: string;
  at: string;
}

export type JobStatus = "done" | "blocked" | "needs_input" | "failed" | "step_limit" | "interrupted";

export interface Task {
  id: string;
  /** What the user asked for, in his words. */
  goal: string;
  startedAt: string;
  /** Things learned along the way that the next job needs: an org's host, a working URL, a name. */
  facts: Record<string, string>;
  jobs: TaskJob[];
  /** Hosts the worker's pages actually landed on — the host guard's memory. */
  hosts: string[];
  /** Documents the user attached to this task (a charter, a plan): ids in the attachment store. */
  docs: Array<{ id: string; name: string }>;
  status: "open" | "done" | "dropped";
}

const MAX_JOBS = 40;
const MAX_SUMMARY = 1_500;
const MAX_FACTS = 40;

export function defaultTaskDir(): string {
  return path.join(process.env.JEV_HOME ?? path.join(homedir(), ".jev"));
}

export class TaskStore {
  private task: Task | null;

  /** `dir: null` keeps the task in memory only (tests). */
  constructor(
    private readonly dir: string | null = defaultTaskDir(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.task = this.load();
  }

  get current(): Task | null {
    return this.task && this.task.status === "open" ? this.task : null;
  }

  open(goal: string): Task {
    if (this.current) return this.current;
    const at = this.now();
    this.task = { id: `task_${at.getTime().toString(36)}`, goal: goal.slice(0, 2_000), startedAt: at.toISOString(), facts: {}, jobs: [], hosts: [], docs: [], status: "open" };
    this.save();
    return this.task;
  }

  note(key: string, value: string): void {
    const t = this.current;
    if (!t) return;
    const k = key.trim().slice(0, 80);
    if (!k) return;
    if (!(k in t.facts) && Object.keys(t.facts).length >= MAX_FACTS) return;
    t.facts[k] = value.trim().slice(0, 500);
    this.save();
  }

  addJob(goal: string, status: JobStatus, summary: string): void {
    const t = this.current;
    if (!t) return;
    t.jobs.push({ goal: goal.slice(0, 500), status, summary: summary.slice(0, MAX_SUMMARY), at: this.now().toISOString() });
    if (t.jobs.length > MAX_JOBS) t.jobs.splice(0, t.jobs.length - MAX_JOBS);
    this.save();
  }

  /** A page the worker landed on. Kept by host, so the guard knows which ones are real. */
  sawHost(host: string): void {
    const t = this.current;
    const h = host.toLowerCase();
    if (!t || !h || t.hosts.includes(h)) return;
    t.hosts.push(h);
    if (t.hosts.length > 200) t.hosts.splice(0, t.hosts.length - 200);
    this.save();
  }

  attach(doc: { id: string; name: string }): void {
    const t = this.current;
    if (!t || t.docs.some((d) => d.id === doc.id)) return;
    t.docs.push(doc);
    this.save();
  }

  /** Finished or dropped: moved out of the way, kept for the record. */
  close(status: "done" | "dropped"): Task | null {
    const t = this.current;
    if (!t) return null;
    t.status = status;
    if (this.dir) {
      try {
        const archive = path.join(this.dir, "tasks");
        mkdirSync(archive, { recursive: true, mode: 0o700 });
        writeFileSync(path.join(archive, `${t.id}.json`), JSON.stringify(t, null, 2), { mode: 0o600 });
        rmSync(this.file()!, { force: true });
      } catch {
        /* the record is a nicety; the task is closed either way */
      }
    }
    this.task = null;
    return t;
  }

  /** The task as the lead is shown it at the start of each run. */
  brief(): string | null {
    const t = this.current;
    if (!t) return null;
    const lines = [`Open task (${t.id}, started ${t.startedAt}): ${t.goal}`];
    const facts = Object.entries(t.facts);
    if (facts.length) lines.push("Facts learned so far:", ...facts.map(([k, v]) => `- ${k}: ${v}`));
    if (t.hosts.length) lines.push(`Sites the worker has actually been on: ${t.hosts.join(", ")}`);
    if (t.docs.length) lines.push(`Documents attached: ${t.docs.map((d) => `${d.name} (${d.id})`).join(", ")}`);
    if (t.jobs.length) {
      lines.push("Jobs so far (oldest first):");
      for (const j of t.jobs.slice(-10)) lines.push(`- [${j.status}] ${j.goal} → ${j.summary.replace(/\s+/g, " ").slice(0, 400)}`);
    }
    return lines.join("\n");
  }

  private file(): string | null {
    return this.dir ? path.join(this.dir, "task.json") : null;
  }

  private load(): Task | null {
    const f = this.file();
    if (!f || !existsSync(f)) return null;
    try {
      const t = JSON.parse(readFileSync(f, "utf8")) as Partial<Task>;
      if (typeof t.id !== "string" || typeof t.goal !== "string" || t.status !== "open") return null;
      return { id: t.id, goal: t.goal, startedAt: t.startedAt ?? this.now().toISOString(), facts: t.facts ?? {}, jobs: Array.isArray(t.jobs) ? t.jobs : [], hosts: Array.isArray(t.hosts) ? t.hosts : [], docs: Array.isArray(t.docs) ? t.docs : [], status: "open" };
    } catch {
      return null;
    }
  }

  /** tmp + rename, mode 0600: a task can name private things. */
  private save(): void {
    const f = this.file();
    if (!f || !this.task) return;
    try {
      mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.task, null, 2), { mode: 0o600 });
      renameSync(tmp, f);
    } catch {
      /* a full disk shouldn't stop the work */
    }
  }
}
