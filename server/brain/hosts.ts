/** Which hosts a job may open by typing their address, and which it must reach by clicking.
 *
 *  Live 2026-09-28: the user's Salesforce org is example-tenant-123.my.salesforce.com. Runs 3, 4, 6
 *  and 8 navigated to hostnames that had never appeared anywhere — orgfarm-e69c71ef60-dev-ed… — landed
 *  on Chrome error pages, and then misread those as "your session dropped". A tenant's hostname is a
 *  value like any other: it has to come from the user, a page, or where a page actually landed. */

export function hostOf(url: string): string | null {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

const HOST = /\b(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?=[/:?#\s"'),.\]]|$)/gi;
/** Endings that look like a TLD but are file names in prose ("notes.md", "task.json"). */
const NOT_TLD = new Set(["md", "json", "ts", "js", "png", "jpg", "txt", "csv", "pdf", "html", "yaml", "yml", "log", "tsx", "mjs", "sh", "py"]);

/** Every hostname written in a piece of text: the user's words, a fact, a page's text or links. */
export function hostsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(HOST)) {
    const h = m[1]!.toLowerCase();
    if (NOT_TLD.has(h.slice(h.lastIndexOf(".") + 1))) continue;
    out.add(h);
  }
  return [...out];
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);

/** The registrable part: salesforce.com for anything.my.salesforce.com, bbc.co.uk for news.bbc.co.uk. */
export function siteOf(host: string): string {
  const parts = host.toLowerCase().split(".");
  if (parts.length <= 2) return parts.join(".");
  const tld = parts.at(-1)!;
  const sld = parts.at(-2)!;
  return (tld.length === 2 && SECOND_LEVEL.has(sld) ? parts.slice(-3) : parts.slice(-2)).join(".");
}

/** A label that names one customer's instance — an org id, a store handle with digits. Such a name
 *  can't be guessed; docs.google.com or login.salesforce.com can. */
export function looksTenant(host: string): boolean {
  const labels = host.split(".").slice(0, -2);
  return labels.some((l) => (/\d/.test(l) && l.length >= 4) || l.length >= 20);
}

/** Null when the address may be opened; otherwise what to tell the worker instead. */
export function guardNavigate(url: string, known: Iterable<string>): string | null {
  const host = hostOf(url);
  if (!host) return null;
  const seen = new Set([...known].map((h) => h.toLowerCase()));
  if (seen.has(host) || !looksTenant(host)) return null;
  const site = siteOf(host);
  const same = [...seen].filter((h) => siteOf(h) === site);
  if (same.length)
    return `Not opening ${host}: that hostname hasn't appeared anywhere in this task. The ${site} host${same.length > 1 ? "s" : ""} you've actually been on: ${same.join(", ")}. Use one of those, or click through from a page — never guess an org or tenant hostname.`;
  return `Not opening ${host}: that hostname hasn't appeared anywhere in this task, and a tenant's address can't be guessed. Open https://${site} (or the login page the user uses) and follow where it takes you, or report needs_input and ask for the address.`;
}

/** Chrome's own error page, or a site's ("Error Page" — Salesforce's answer for an org host that
 *  doesn't exist, which says "We are setting things up"): the address is wrong. Not a login or
 *  session problem, and not an org still being created. */
export function isErrorPage(url: string, detail = ""): boolean {
  return /^chrome-error:/i.test(url) || /showing error page|ERR_[A-Z_]+|can.t be reached|DNS_PROBE|^\s*error page\b/i.test(detail);
}
