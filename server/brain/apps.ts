/** Connectors: ClickUp, Slack and Gmail through their real APIs, via Composio — so "send Xander hi
 *  in Slack" posts to a channel by ID instead of clicking around a window (the ClearbluGroup
 *  failure). Cloud, and needs COMPOSIO_API_KEY (a PROJECT key, `ak_…`; the CLI's `uak_` user key is
 *  refused by the SDK).
 *
 *  The brain gets a NAMED list of actions, never a whole toolkit — Hermes drowned in 429 tools.
 *  Writes (send, post, create, update) wait for the user through the same gate as every other write. */
import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import type { ToolSet } from "ai";
import { type ToolContext, alreadySent, recordSent } from "./tools.js";

/** Reads: run straight away. */
export const APP_READS = [
  "CLICKUP_GET_AUTHORIZED_TEAMS_WORKSPACES",
  "CLICKUP_GET_SPACES",
  "CLICKUP_GET_LISTS",
  "CLICKUP_GET_TASKS",
  "CLICKUP_GET_FILTERED_TEAM_TASKS",
  "CLICKUP_GET_TASK",
  "SLACK_LIST_CONVERSATIONS",
  "SLACK_FIND_CHANNELS",
  "SLACK_FETCH_CONVERSATION_HISTORY",
  "SLACK_SEARCH_MESSAGES",
  "GMAIL_FETCH_EMAILS",
  "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
  // a draft never leaves the account, so it is not gated
  "GMAIL_CREATE_EMAIL_DRAFT",
] as const;

/** Writes: each one is asked about first, in plain words. */
export const APP_WRITES: Record<string, string> = {
  CLICKUP_CREATE_TASK: "create a ClickUp task",
  CLICKUP_UPDATE_TASK: "update a ClickUp task",
  SLACK_SEND_MESSAGE: "send a Slack message",
  GMAIL_SEND_EMAIL: "send an email",
  GMAIL_REPLY_TO_THREAD: "reply to an email",
};

export const APP_ACTIONS: string[] = [...APP_READS, ...Object.keys(APP_WRITES)];

/** Which toolkit an action belongs to: CLICKUP_CREATE_TASK → clickup. */
export const toolkitOf = (slug: string) => slug.split("_")[0]!.toLowerCase();

export interface AppsLoad {
  tools: ToolSet;
  accounts?: Record<string, string>;
  /** One line for the startup log and the brain's health: what loaded, and what is not connected. */
  note: string;
}

export interface AppsLoader {
  load(): Promise<AppsLoad>;
}

/** The few argument fields worth reading aloud in a yes/no question. */
function detail(args: Record<string, unknown>): string {
  const pick = ["channel", "channel_name", "recipient_email", "to", "subject", "name", "text", "markdown_text", "body", "message_body"];
  const parts = pick.filter((k) => typeof args[k] === "string" && args[k]).map((k) => String(args[k]).replace(/\s+/g, " ").slice(0, 80));
  return parts.length ? `: ${parts.join(" — ")}` : "";
}

/** The words a connector write would send, when it sends words (a Slack message, an email body). */
function messageText(args: Record<string, unknown>): string | null {
  for (const k of ["text", "markdown_text", "message", "body"]) if (typeof args[k] === "string" && (args[k] as string).trim()) return args[k] as string;
  return null;
}

/** Put the write gate in front of every write action. Reads pass through untouched. */
export function gateApps(tools: ToolSet, ctx: ToolContext): ToolSet {
  const out: ToolSet = {};
  const attempts = new Map<string, "unconfirmed" | "completed" | "failed">();
  for (const [slug, t] of Object.entries(tools)) {
    const what = APP_WRITES[slug];
    if (!what || !t.execute) {
      out[slug] = t;
      continue;
    }
    const execute = t.execute;
    out[slug] = {
      ...t,
      execute: (async (args: Record<string, unknown>, options: unknown) => {
        const text = messageText(args ?? {});
        const dup = text ? alreadySent(ctx, text) : null;
        if (dup) return dup;
        const fingerprint = `${slug}:${JSON.stringify(args, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)}`;
        if (attempts.has(fingerprint)) return `This app action was already attempted (${attempts.get(fingerprint)}). Reconcile its result before any repeat; do not send it another way.`;
        if (!ctx.appWriteAllowed?.(slug) && !(await ctx.ask(`${what}${detail(args ?? {})}`))) return "the user said no. Do not do this another way; stop and tell him.";
        if (ctx.signal.aborted) return "Stopped.";
        attempts.set(fingerprint, "unconfirmed");
        let done: unknown;
        try { done = await (execute as (a: unknown, o: unknown) => Promise<unknown>)(args, options); }
        catch { return "The app action's outcome is unconfirmed. Inspect the app or ask the user to reconcile it before retrying. Do not repeat this write through another tool."; }
        if (done && typeof done === "object" && "successful" in done && done.successful === false) { attempts.set(fingerprint, "failed"); return done; }
        attempts.set(fingerprint, "completed");
        if (text) recordSent(ctx, text, what);
        return done;
      }) as typeof t.execute,
    } as ToolSet[string];
  }
  return out;
}

export function createComposioApps(env: NodeJS.ProcessEnv = process.env): AppsLoader | null {
  const apiKey = env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) return null;
  const userId = env.COMPOSIO_USER_ID?.trim() || "default";
  const wanted = env.JEV_APP_ACTIONS?.trim() ? env.JEV_APP_ACTIONS.split(",").map((s) => s.trim()).filter(Boolean) : APP_ACTIONS;
  return {
    async load() {
      const composio = new Composio({ apiKey, provider: new VercelProvider() });
      // Only the apps that are actually connected: an action for an unconnected app would fail on
      // every call, and the model would waste steps discovering that.
      let accounts: Array<{ id: string; toolkit: { slug: string } }>;
      try {
        const r = await composio.connectedAccounts.list({ userIds: [userId], statuses: ["ACTIVE"] }, { signal: AbortSignal.timeout(15000) });
        accounts = r.items;
      } catch {
        return { tools: {}, note: "Could not verify connected accounts; app tools are unavailable. Check Composio settings." };
      }
      const single = new Map<string, string>();
      for (const slug of new Set(wanted.map(toolkitOf))) {
        const matching = accounts.filter((a) => a.toolkit.slug.toLowerCase() === slug);
        if (matching.length === 1) single.set(slug, matching[0]!.id);
      }
      const slugs = wanted.filter((s) => single.has(toolkitOf(s)));
      const missing = [...new Set(wanted.map(toolkitOf))].filter((t) => !single.has(t));
      const tools = slugs.length ? ((await composio.tools.get(userId, { tools: slugs }, { signal: AbortSignal.timeout(15000) })) as unknown as ToolSet) : {};
      // Pin execution to the exact account inspected above; never select another identity silently.
      for (const [slug, tool] of Object.entries(tools)) {
        const account = single.get(toolkitOf(slug));
        if (!account || !APP_ACTIONS.includes(slug)) { delete tools[slug]; continue; }
        tool.execute = (async (args: Record<string, unknown>, options: { abortSignal?: AbortSignal }) => composio.tools.execute(slug, { userId, connectedAccountId: account, arguments: args }, { signal: options?.abortSignal ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) })) as typeof tool.execute;
      }
      const apps = [...new Set(Object.keys(tools).map(toolkitOf))];
      const note = `${Object.keys(tools).length} app actions${apps.length ? ` (${apps.join(", ")})` : ""}${missing.length ? `; needs one selected connected account: ${missing.join(", ")} — check Connection settings` : ""}`;
      return { tools, note, accounts: Object.fromEntries(single) };
    },
  };
}
