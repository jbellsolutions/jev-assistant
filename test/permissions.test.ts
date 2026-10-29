import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AppPermissions, spokenApproval } from "../server/assistant/permissions.js";
import { gateApps } from "../server/brain/apps.js";
import { vi } from "vitest";
import type { ToolSet } from "ai";
it("remembered app permissions bypass only that app gate and retain duplicate protection", async () => {
  const send = vi.fn(async () => ({ successful: true, id: "test-message" }));
  const ask = vi.fn(async () => false);
  const tool = { description: "test", inputSchema: {}, execute: send } as unknown as ToolSet[string];
  const tools = gateApps({ SLACK_SEND_MESSAGE: tool, GMAIL_SEND_EMAIL: tool }, { signal: new AbortController().signal, ask, appWriteAllowed: (slug) => slug === "SLACK_SEND_MESSAGE" });
  const exec = (slug: string, args: unknown) => (tools[slug]!.execute as (args: unknown, options: unknown) => Promise<unknown>)(args, {});
  await exec("SLACK_SEND_MESSAGE", { channel: "reviewed-test-channel", text: "test message" });
  expect(send).toHaveBeenCalledOnce(); expect(ask).not.toHaveBeenCalled();
  await exec("SLACK_SEND_MESSAGE", { channel: "reviewed-test-channel", text: "test message" }); expect(send).toHaveBeenCalledOnce();
  await exec("GMAIL_SEND_EMAIL", { to: "test@example.test", body: "a different test" }); expect(ask).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
});
it("remembers an explicitly selected app action only for the connected account and permits revocation", () => {
  const home = mkdtempSync(path.join(tmpdir(), "jarvis-permissions-"));
  try {
    const permissions = new AppPermissions(home);
    expect(permissions.enabled).toBe(true);
    expect(permissions.allowed("SLACK_SEND_MESSAGE", "account-one")).toBe(true);
    permissions.setEnabled(false);
    expect(permissions.allowed("SLACK_SEND_MESSAGE", "account-one")).toBe(false);
    permissions.set("SLACK_SEND_MESSAGE", "account-one", true);
    const restored = new AppPermissions(home);
    expect(restored.enabled).toBe(false);
    expect(restored.allowed("SLACK_SEND_MESSAGE", "account-one")).toBe(true);
    expect(restored.allowed("SLACK_SEND_MESSAGE", "account-two")).toBe(false);
    expect(restored.allowed("GMAIL_SEND_EMAIL", "account-one")).toBe(false);
    expect(statSync(path.join(home, "permissions.json")).mode & 0o777).toBe(0o600);
    restored.set("SLACK_SEND_MESSAGE", "account-one", false);
    expect(new AppPermissions(home).allowed("SLACK_SEND_MESSAGE", "account-one")).toBe(false);
    expect(() => restored.set("DELETE_EVERYTHING", "account-one", true)).toThrow();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
it("understands short spoken answers without treating quoted text or changed instructions as approvals", () => {
  for (const phrase of ["Yes, send it.", "Yeah, go ahead", "Okay, please", "Go ahead and send it", "Approve that", "Yeah, that's fine", "Yes, go ahead and send that please", "Sounds good"]) expect(spokenApproval(phrase)).toBe("once");
  for (const phrase of ["No, don't send it", "Don't do that", "No thanks", "Cancel that action"]) expect(spokenApproval(phrase)).toBe("deny");
  for (const phrase of ["Tell him yes", 'The message says "yes"', "Yes but change the recipient", "Send it to another channel", "Always allow everything"]) expect(spokenApproval(phrase)).toBeNull();
});

it("does not broaden permissions when a saved setting is unreadable", () => {
  const home = mkdtempSync(path.join(tmpdir(), "jarvis-permissions-corrupt-"));
  try {
    writeFileSync(path.join(home, "permissions.json"), "{broken");
    expect(new AppPermissions(home).enabled).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
