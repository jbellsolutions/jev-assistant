import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { BrainEvent, BrainRun } from "../core/brain.js";
import { speakableText } from "../core/speak.js";
import { AgentBrain } from "../server/brain/agent.js";
import { guardNavigate, hostsIn, looksTenant, siteOf } from "../server/brain/hosts.js";
import { fileRunLog } from "../server/brain/runlog.js";
import { looksSecret, SecretVault } from "../server/brain/secrets.js";
import { buildTools, type Hands, renderSnapshot, type ToolContext } from "../server/brain/tools.js";
import { FakeExecutor, el } from "./helpers/fake-executor.js";

const ORG = "example-tenant-123.my.salesforce.com";
const KEY = "TEST_ONLY_CONSUMER_KEY_DO_NOT_USE_1234567890";
const SECRET = "TEST_ONLY_CONSUMER_SECRET_DO_NOT_USE_1234567890";

function toolsFor(ctx: Partial<ToolContext> = {}) {
  const bg = new FakeExecutor([el("e0", { tag: "input", type: "text", label: "App Name", value: "" })], "chrome-jev");
  const his = new FakeExecutor([], "chrome");
  const hands = { chrome: his, chromeBackground: bg, mac: null, computer: null } as Hands;
  const asked: string[] = [];
  const full: ToolContext = { signal: new AbortController().signal, ask: async (s) => (asked.push(s), true), ...ctx };
  const tools = buildTools(hands, full);
  const run = (name: string, input: unknown) => (tools[name]!.execute as (i: unknown, o: unknown) => Promise<string>)(input, { toolCallId: "t", messages: [] });
  return { bg, his, run, asked };
}

describe("host guard (Salesforce, live 2026-09-28)", () => {
  it("refuses an invented tenant host when the site is known under a real one, and says which", async () => {
    const { bg, run } = toolsFor({ knownHosts: () => [ORG] });
    const out = await run("chrome", { action: "navigate", url: "https://orgfarm-e69c71ef60-dev-ed.develop.my.salesforce.com/lightning/setup/" });
    expect(out).toContain("hasn't appeared anywhere");
    expect(out).toContain(ORG);
    expect(bg.executed).toHaveLength(0);
  });

  it("lets a real host, a plain subdomain and a brand-new site through", async () => {
    const { bg, run } = toolsFor({ knownHosts: () => [ORG, "mail.google.com"] });
    await run("chrome", { action: "navigate", url: `https://${ORG}/lightning/setup/ManageExternalClientApplication/home` });
    await run("chrome", { action: "navigate", url: "docs.google.com" });
    await run("chrome", { action: "navigate", url: "https://news.ycombinator.com" });
    expect(bg.executed.map((a) => a.kind)).toEqual(["navigate", "navigate", "navigate"]);
  });

  it("learns hosts from where pages land and from what they show, not just from navigate", async () => {
    const { bg, run } = toolsFor();
    bg.url = `https://${ORG}/home`;
    bg.pageText = "Your My Domain URL is example-tenant-123.lightning.force.com";
    await run("chrome", { action: "read_text" });
    await run("chrome", { action: "navigate", url: "https://example-tenant-123.lightning.force.com/one" });
    expect(bg.executed).toHaveLength(1);
    expect(await run("chrome", { action: "navigate", url: "https://orgfarm-1234abcd.my.salesforce.com" })).toContain(ORG);
  });

  it("names the Chrome error page for what it is and points back to the last page that worked", async () => {
    const { bg, run } = toolsFor();
    bg.url = `https://${ORG}/home`;
    await run("chrome", { action: "read_elements" });
    bg.pageText = null;
    bg.read = async () => {
      throw new Error("Frame with ID 0 is showing error page");
    };
    const out = await run("chrome", { action: "navigate", url: "https://login.salesforce.com/nope" });
    expect(out).toContain("NOT a login, session");
    expect(out).toContain(`https://${ORG}/home`);
  });

  it("helpers: site, tenant, hosts in prose", () => {
    expect(siteOf(ORG)).toBe("salesforce.com");
    expect(siteOf("news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(looksTenant(ORG)).toBe(true);
    expect(looksTenant("docs.google.com")).toBe(false);
    expect(hostsIn("go to https://example-tenant-123.my.salesforce.com/x and read notes.md")).toEqual([ORG]);
    expect(guardNavigate("https://acme-42.myshopify.com", [])).toContain("can't be guessed");
  });
});

describe("one tab per job", () => {
  it("a background job can't move into the user's tab; a his_tab job defaults to it", async () => {
    const bgJob = toolsFor({ tab: "background" });
    expect(await bgJob.run("chrome", { action: "read_elements", tab: "his_tab" })).toContain("his tab is his");
    expect(bgJob.his.snapshots).toBe(0);
    const hisJob = toolsFor({ tab: "his_tab" });
    await hisJob.run("chrome", { action: "read_elements" });
    expect(hisJob.his.snapshots).toBe(1);
    expect(hisJob.bg.snapshots).toBe(0);
  });
});

describe("fields show what they hold", () => {
  it("read_elements shows values, and passwords only as dots", () => {
    const out = renderSnapshot({
      url: "https://x.test",
      title: "Form",
      elements: [el("e0", { tag: "input", label: "App Name", value: "Lead Sync" }), el("e1", { tag: "input", label: "Email", value: "" }), el("e2", { tag: "input", type: "password", label: "Password", value: "••••••" })],
    });
    expect(out).toContain('e0 input "App Name" = "Lead Sync"');
    expect(out).toContain('e1 input "Email" (empty)');
    expect(out).toContain('"••••••"');
  });

  it("after type, the field is read back", async () => {
    const { bg, run } = toolsFor();
    await run("chrome", { action: "read_elements" });
    bg.execute = async (a) => {
      bg.executed.push(a);
      if (a.kind === "type") bg.elements = [el("e0", { tag: "input", type: "text", label: "App Name", value: "Never Buy Leads Again Site" })];
      return "typed";
    };
    const out = await run("chrome", { action: "type", element_id: "e0", text: "Lead Sync" });
    expect(out).toContain('The field now holds: "Never Buy Leads Again Site"');
  });
});

describe("secrets never reach the model", () => {
  it("masks key-like page text and labelled values, keeps URLs, UUIDs and commit ids", () => {
    const v = new SecretVault();
    const out = v.mask(`Consumer Key\n${KEY}\nConsumer Secret: ${SECRET}\nSee https://${ORG}/lightning/setup/ManageExternalClientApplication/home id 0b7c9d6e-2f1a-4c3b-9e8d-7a6b5c4d3e2f sha 3f786850e387550fdab836ed7e6dc881de23001b`);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(SECRET);
    expect(out).toMatch(/\{\{secret:s1 …[^}]{4}\}\}/);
    expect(out).toContain(`https://${ORG}/lightning/setup/ManageExternalClientApplication/home`);
    expect(out).toContain("0b7c9d6e-2f1a-4c3b-9e8d-7a6b5c4d3e2f");
    expect(out).toContain("3f786850e387550fdab836ed7e6dc881de23001b");
    expect(looksSecret("manage-external-client-application-home")).toBe(false);
    expect(speakableText("Saved {{secret:sf_consumer_key …xYz}} to the file.")).toBe("Saved a secret to the file.");
  });

  it("the worker names a secret and types it by handle; the value is filled in only at the executor", async () => {
    const secrets = new SecretVault();
    secrets.mask(`Consumer Key: ${KEY}`);
    const { bg, run, asked } = toolsFor({ secrets });
    expect(await run("secret", { action: "name", handle: "{{secret:s1 …yZ}}", name: "sf_consumer_key" })).toContain("{{secret:sf_consumer_key");
    await run("chrome", { action: "read_elements" });
    await run("chrome", { action: "type", element_id: "e0", text: "{{secret:sf_consumer_key}}", submit: true });
    expect(asked[0]).toContain("{{secret:sf_consumer_key}}");
    expect(asked[0]).not.toContain(KEY);
    expect(bg.executed.at(-1)).toMatchObject({ kind: "type", text: KEY });
    expect(await run("chrome", { action: "type", element_id: "e0", text: "{{secret:nope}}" })).toContain("No secret named nope");
  });

  it("a co-founder request can't open the user's secrets", async () => {
    const secrets = new SecretVault();
    secrets.mask(`api key ${KEY}`);
    const { bg, run } = toolsFor({ secrets, secretsLocked: true });
    await run("chrome", { action: "read_elements" });
    expect(await run("chrome", { action: "type", element_id: "e0", text: "{{secret:s1}}" })).toContain("co-founder");
    expect(bg.executed).toHaveLength(0);
  });

  it("end to end: shown as plain page text on the FIRST read, the value never reaches the model or the run log", async () => {
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const call = (toolName: string, input: unknown) => ({ content: [{ type: "tool-call", toolCallId: `c${toolName}${JSON.stringify(input).length}`, toolName, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage, warnings: [] });
    const steps = [call("chrome", { action: "read_text" }), call("chrome", { action: "read_elements" }), call("chrome", { action: "type", element_id: "e0", text: "{{secret:s1}}" }), { content: [{ type: "text", text: `STATUS: done\nCopied the key.` }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }];
    let i = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => steps[Math.min(i++, steps.length - 1)] as never });
    const bg = new FakeExecutor([el("e0", { tag: "input", type: "text", label: "Key", value: "" })], "chrome-jev");
    bg.pageText = `New app created. Consumer Key\n${KEY}\nConsumer Secret\n${SECRET}`;
    const dir = mkdtempSync(path.join(tmpdir(), "jev-secret-"));
    const brain = new AgentBrain({ model, modelId: "t", hands: { chrome: bg, chromeBackground: bg, mac: null, computer: null } as Hands, instructions: () => "worker", log: fileRunLog(dir) });
    const events: BrainEvent[] = [];
    const r: BrainRun = await brain.send("copy the key", { job: { brief: "job" } });
    for await (const e of r.events) events.push(e);
    const seenByModel = JSON.stringify(model.doGenerateCalls.map((c) => c.prompt));
    expect(seenByModel).toContain("{{secret:s1");
    expect(seenByModel).not.toContain(KEY);
    expect(seenByModel).not.toContain(SECRET);
    const logged = readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl")).map((f) => readFileSync(path.join(dir, String(f)), "utf8")).join("");
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(bg.executed.at(-1)).toMatchObject({ kind: "type", text: KEY });
  });
});

describe("fixes from the real Salesforce logs", () => {
  it("an address is never mistaken for a secret, so the guard's answer reaches the worker intact", () => {
    const v = new SecretVault();
    const line = `The salesforce.com host you've actually been on: ${ORG}. Use it.`;
    expect(v.mask(line)).toBe(line);
  });

  it("Salesforce's own 'Error Page' (\"We are setting things up\") is an error page, not an org being created", async () => {
    const { bg, run } = toolsFor();
    bg.url = "https://orgfarm-e69c71ef60-dev-ed.develop.lightning.force.com/";
    bg.titleText = "Error Page";
    expect(await run("chrome", { action: "read_elements" })).toContain("NOT a login, session");
  });

  it("a click that lands on a new host is learned and said, without another read", async () => {
    const { bg, run } = toolsFor();
    bg.url = `https://${ORG}/home`;
    await run("chrome", { action: "read_elements" });
    bg.elements = [el("e0", { tag: "a", text: "Setup" })];
    await run("chrome", { action: "read_elements" });
    bg.execute = async (a) => {
      bg.executed.push(a);
      bg.url = "https://example-tenant-123.lightning.force.com/lightning/setup/SetupOneHome/home";
      return "clicked";
    };
    expect(await run("chrome", { action: "click", element_id: "e0" })).toContain("Now on https://example-tenant-123.lightning.force.com/");
    bg.execute = async (a) => (bg.executed.push(a), "ok");
    await run("chrome", { action: "navigate", url: "https://example-tenant-123.lightning.force.com/lightning/setup/ManageExternalClientApplication/home" });
    expect(bg.executed.at(-1)).toMatchObject({ kind: "navigate" });
  });

  it("through the real wrapper: a refused navigate hands the worker the real host, unmasked", async () => {
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const steps = [
      { content: [{ type: "tool-call", toolCallId: "n1", toolName: "chrome", input: JSON.stringify({ action: "navigate", url: "https://orgfarm-e69c71ef60-dev-ed.my.salesforce.com/" }) }], finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage, warnings: [] },
      { content: [{ type: "text", text: "STATUS: blocked\nwrong host" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] },
    ];
    let i = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => steps[Math.min(i++, 1)] as never });
    const bg = new FakeExecutor([], "chrome-jev");
    const brain = new AgentBrain({ model, modelId: "t", hands: { chrome: bg, chromeBackground: bg, mac: null, computer: null } as Hands, instructions: () => "worker" });
    const r = await brain.send("open setup", { job: { brief: "job", hosts: () => [ORG] } });
    for await (const _ of r.events);
    const second = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    expect(second).toContain(`host you've actually been on: ${ORG}`);
    expect(second).not.toContain("{{secret:");
    expect(bg.executed).toHaveLength(0);
  });
});

describe("Your screen after the work (live 2026-09-29)", () => {
  it("a run that ends on mac_read lets go of that app, so the pane goes back to what the user has in front", async () => {
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const steps = [
      { content: [{ type: "tool-call", toolCallId: "m1", toolName: "mac_read", input: JSON.stringify({ app: "Finder" }) }], finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage, warnings: [] },
      { content: [{ type: "text", text: "Cleaned Data." }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] },
    ];
    let i = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => steps[Math.min(i++, 1)] as never });
    const mac = Object.assign(new FakeExecutor([], "mac"), { released: 0, release() { this.released++; } });
    const brain = new AgentBrain({ model, modelId: "t", hands: { chrome: null, mac, computer: null } as Hands, instructions: () => "w" });
    const r = await brain.send("what folder is open in Finder?");
    for await (const _ of r.events);
    expect(mac.snapshots).toBe(1);
    expect(mac.released).toBeGreaterThanOrEqual(1);
  });
});
