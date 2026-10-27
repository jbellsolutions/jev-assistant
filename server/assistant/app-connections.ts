import { Composio } from "@composio/core";
export const SUPPORTED_APPS = ["slack", "gmail", "clickup"] as const;
export function appConnections(env: NodeJS.ProcessEnv) {
  const client = () => {
    if (!env.COMPOSIO_API_KEY?.trim()) throw new Error("Add a Composio project key in Your connections, then restart Jarvis.");
    return new Composio({ apiKey: env.COMPOSIO_API_KEY });
  };
  const userId = env.COMPOSIO_USER_ID?.trim() || "default";
  return {
    async selectedAccounts() {
      const r = await client().connectedAccounts.list({ userIds: [userId], statuses: ["ACTIVE"] }, { signal: AbortSignal.timeout(15000) });
      const selected = new Map<string, string>();
      for (const slug of SUPPORTED_APPS) { const matches = r.items.filter((a) => a.toolkit.slug.toLowerCase() === slug); if (matches.length === 1) selected.set(slug, matches[0]!.id); }
      return selected;
    },
    async list() {
      const c = client();
      try {
        const r = await c.connectedAccounts.list({ userIds: [userId], statuses: ["ACTIVE"] }, { signal: AbortSignal.timeout(15000) });
        return SUPPORTED_APPS.map((slug) => {
          const accounts = r.items.filter((a) => a.toolkit.slug.toLowerCase() === slug).length;
          return { slug, accounts, connected: accounts === 1, ambiguous: accounts > 1 };
        });
      } catch { throw new Error("Could not load Composio accounts. Check the project key and user ID."); }
    },
    async connect(slug: unknown) {
      if (typeof slug !== "string" || !(SUPPORTED_APPS as readonly string[]).includes(slug)) throw new Error("Choose Slack, Gmail or ClickUp");
      const c = client();
      try {
        const r = await c.toolkits.authorize(userId, slug, undefined, { signal: AbortSignal.timeout(15000) });
        const url = new URL(r.redirectUrl!);
        if (url.protocol !== "https:" || !/(^|\.)composio\.(dev|app)$/.test(url.hostname)) throw new Error("Unexpected connection address");
        return url.href;
      } catch { throw new Error("Could not start app authorization. Check your Composio project settings."); }
    },
  };
}
