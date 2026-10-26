// Connect one app to Jev's connectors, once:  npm run connect -- slack   (or clickup, gmail)
// Prints a Composio sign-in link; open it, approve, and the app's actions appear on Jev's next start.
import { Composio } from "@composio/core";
import { loadConfiguration } from "../server/configuration.ts";

loadConfiguration(process.cwd());
const app = (process.argv[2] ?? "").toLowerCase();
if (!app) throw new Error("usage: npm run connect -- <clickup|slack|gmail>");
const apiKey = process.env.COMPOSIO_API_KEY?.trim();
if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set in .env (a project key from dashboard.composio.dev → Settings → API keys, starting ak_)");
const userId = process.env.COMPOSIO_USER_ID?.trim() || "default";
const composio = new Composio({ apiKey });
const request = await composio.toolkits.authorize(userId, app);
console.log(`Open this to connect ${app}:\n\n  ${request.redirectUrl}\n`);
if (typeof request.waitForConnection === "function") {
  console.log("Waiting for you to finish (up to 5 minutes)…");
  const account = await request.waitForConnection(300_000);
  console.log(`Connected ${app} (${account.status ?? "ok"}). Restart Jev to load its actions.`);
}
