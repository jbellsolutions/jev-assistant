import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PERMISSION_ACTIONS = { SLACK_SEND_MESSAGE: "Send Slack messages", CLICKUP_CREATE_TASK: "Create ClickUp tasks", CLICKUP_UPDATE_TASK: "Update ClickUp tasks", GMAIL_SEND_EMAIL: "Send email", GMAIL_REPLY_TO_THREAD: "Reply to email" } as const;
export class AppPermissions {
  private grants: Record<string, string[]> = {};
  private file: string;
  enabled = true;
  constructor(home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 }); this.file = path.join(home, "permissions.json");
    try { const data = JSON.parse(readFileSync(this.file, "utf8")); this.enabled = data.enabled !== false; for (const slug of Object.keys(PERMISSION_ACTIONS)) if (Array.isArray(data[slug])) this.grants[slug] = data[slug].filter((s: unknown) => typeof s === "string"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.enabled = false; }
  }
  allowed(slug: string, account: string) { return !!account && Object.hasOwn(PERMISSION_ACTIONS, slug) && (this.enabled || !!this.grants[slug]?.includes(account)); }
  setEnabled(enabled: boolean) { this.save(enabled); this.enabled = enabled; }
  private save(enabled = this.enabled) {
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ ...this.grants, enabled }), { mode: 0o600 }); renameSync(`${this.file}.tmp`, this.file);
  }
  set(slug: string, account: string, allow: boolean) {
    if (!Object.hasOwn(PERMISSION_ACTIONS, slug) || !account) throw new Error("Choose a connected app action");
    const values = new Set(this.grants[slug] ?? []); if (allow) values.add(account); else values.delete(account);
    this.grants[slug] = [...values];
    this.save();
  }
}

/** Deliberately whole replies: quoted text or a different requested action is not a yes. */
export function spokenApproval(text: string): "once" | "deny" | null {
  const reply = text.toLowerCase().replace(/[.,!?'’]/g, "").replace(/\s+/g, " ").trim().replace(/^(?:um|uh) /, "").replace(/ please$/, "").replace(/ now$/, "");
  if (/^(?:(?:yes|yeah|yep|okay|ok|sure)(?: please)?(?: (?:go ahead(?: and (?:send|do) (?:it|that))?|(?:send|do) (?:it|that)|approve it|thats fine|you can|sure))?|cool (?:send|do) (?:it|that)|go ahead(?: and (?:send|do) (?:it|that))?|(?:please )?(?:send|do) (?:it|that)|approve(?: it| that)?|allow(?: it| once)?|sounds good|thats fine|that works)$/.test(reply)) return "once";
  if (/^(?:no(?: thanks| thank you| dont(?: send| do) (?:it|that))?|nope|deny(?: it)?|dont(?: send| do) (?:it|that)|cancel (?:that|this) action)$/.test(reply)) return "deny";
  return null;
}
