import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { type CofounderMcpOptions, cofounderMcpHandler, isTailnet, startCofounderMcp, tailnetAddress } from "../server/mcp-remote.js";

const TOKEN = "t".repeat(40);
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

/** Serve the handler on 127.0.0.1 (a test can't bind a tailnet address); `allowed` stands in for
 *  the tailnet check. */
async function serve(over: Partial<CofounderMcpOptions> = {}, allowed?: (a: string | undefined) => boolean) {
  const calls: string[] = [];
  const opts = { token: TOKEN, doTask: async (t: string) => (calls.push(t), { ok: true, output: `did: ${t}` }), look: async () => "Slack — #general", ...over };
  const server = http.createServer(cofounderMcpHandler(opts, allowed));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls };
}
const post = (url: string, auth?: string) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
async function client(url: string) {
  const c = new Client({ name: "cofounder-test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
  return c;
}
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]!.text);

describe("the tailnet check", () => {
  it("is 100.64.0.0/10 only", () => {
    for (const a of ["100.64.0.1", "100.109.42.61", "::ffff:100.69.136.37", "100.127.255.255"]) expect(isTailnet(a), a).toBe(true);
    for (const a of ["127.0.0.1", "192.168.1.5", "100.63.0.1", "100.128.0.1", "10.0.0.1", "::1", undefined, "159.203.88.65"]) expect(isTailnet(a), String(a)).toBe(false);
  });

  it("finds this Mac's tailnet address among its interfaces, or none", () => {
    expect(tailnetAddress({ lo0: [{ family: "IPv4", address: "127.0.0.1" }], utun4: [{ family: "IPv4", address: "100.109.42.61" }] } as never)).toBe("100.109.42.61");
    expect(tailnetAddress({ en0: [{ family: "IPv4", address: "192.168.1.5" }] } as never)).toBeNull();
  });

  it("refuses to listen anywhere but a tailnet address", async () => {
    await expect(startCofounderMcp({ host: "0.0.0.0", token: TOKEN, doTask: async () => ({ ok: true, output: "" }), look: async () => "" })).rejects.toThrow(/not a tailnet address/);
    await expect(startCofounderMcp({ host: "127.0.0.1", token: TOKEN, doTask: async () => ({ ok: true, output: "" }), look: async () => "" })).rejects.toThrow(/not a tailnet address/);
  });
});

describe("the co-founder's MCP endpoint", () => {
  it("a caller outside the tailnet gets 403, token or not", async () => {
    const { url } = await serve(); // the real check: 127.0.0.1 is not on the tailnet
    expect((await post(url, `Bearer ${TOKEN}`)).status).toBe(403);
  });

  it("a wrong or missing token gets 401", async () => {
    const { url } = await serve({}, () => true);
    expect((await post(url)).status).toBe(401);
    expect((await post(url, `Bearer ${"x".repeat(40)}`)).status).toBe(401);
  });

  it("jev_do runs the task through Jev and returns its answer; jev_look reads the screen", async () => {
    const { url, calls } = await serve({}, () => true);
    const c = await client(url);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["jev_do", "jev_look", "jev_result"]);
    expect(textOf(await c.callTool({ name: "jev_do", arguments: { task: "open Slack" } }))).toBe("did: open Slack");
    expect(calls).toEqual(["open Slack"]);
    expect(textOf(await c.callTool({ name: "jev_look", arguments: {} }))).toBe("Slack — #general");
    await c.close();
  });

  it("a slow task answers with a job id; jev_result has the answer once it lands", async () => {
    let finish!: (v: { ok: boolean; output: string }) => void;
    const late: string[] = [];
    const { url } = await serve({ waitMs: 20, doTask: () => new Promise((r) => (finish = r)), onLate: (_t, o) => late.push(o) }, () => true);
    const c = await client(url);
    const first = textOf(await c.callTool({ name: "jev_do", arguments: { task: "long job" } }));
    const id = /job (\S+)\)/.exec(first)![1]!;
    expect(textOf(await c.callTool({ name: "jev_result", arguments: { id } }))).toBe("Still working.");
    finish({ ok: true, output: "All done." });
    await new Promise((r) => setTimeout(r, 10));
    expect(textOf(await c.callTool({ name: "jev_result", arguments: { id } }))).toBe("All done.");
    expect(late).toEqual(["All done."]);
    await c.close();
  });

  it("nothing runs while Jev is paused", async () => {
    const { url, calls } = await serve({ paused: () => true }, () => true);
    const c = await client(url);
    expect(textOf(await c.callTool({ name: "jev_do", arguments: { task: "open Slack" } }))).toMatch(/paused/);
    expect(calls).toEqual([]);
    await c.close();
  });
});
