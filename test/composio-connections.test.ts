import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), execute: vi.fn(), authorize: vi.fn() }));
vi.mock("@composio/core", () => ({ Composio: class { connectedAccounts = { list: mock.list }; tools = { get: mock.get, execute: mock.execute }; toolkits = { authorize: mock.authorize }; } }));
import { createComposioApps } from "../server/brain/apps.js";
import { appConnections } from "../server/assistant/app-connections.js";
beforeEach(() => { vi.resetAllMocks(); });
describe("Composio app connections", () => {
  it("offers only verified supported accounts and pins the exact execution identity", async () => {
    mock.list.mockResolvedValue({ items: [{ id: "account-slack", toolkit: { slug: "slack" } }] });
    mock.get.mockResolvedValue({ SLACK_SEND_MESSAGE: { execute: vi.fn() }, UNEXPECTED_ACTION: { execute: vi.fn() } });
    mock.execute.mockResolvedValue({ successful: true });
    const r = await createComposioApps({ COMPOSIO_API_KEY: "test", COMPOSIO_USER_ID: "justin" })!.load();
    expect(Object.keys(r.tools)).toEqual(["SLACK_SEND_MESSAGE"]);
    expect(mock.get.mock.calls[0]![1].tools.every((s: string) => s.startsWith("SLACK_"))).toBe(true);
    await r.tools.SLACK_SEND_MESSAGE!.execute!({ channel: "C1", text: "hello" }, { toolCallId: "test", messages: [], context: undefined });
    expect(mock.execute).toHaveBeenCalledWith("SLACK_SEND_MESSAGE", expect.objectContaining({ userId: "justin", connectedAccountId: "account-slack" }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it("offers no app actions when account discovery fails or an identity is ambiguous", async () => {
    const loader = createComposioApps({ COMPOSIO_API_KEY: "test" })!;
    mock.list.mockRejectedValueOnce(new Error("private provider detail"));
    const failed = await loader.load(); expect(failed.tools).toEqual({}); expect(failed.note).not.toContain("private provider detail");
    mock.list.mockResolvedValue({ items: [{ id: "one", toolkit: { slug: "slack" } }, { id: "two", toolkit: { slug: "slack" } }] });
    expect((await loader.load()).tools).toEqual({}); expect(mock.get).not.toHaveBeenCalled();
  });
  it("requires a key, validates supported apps and returns only an official authorization URL", async () => {
    await expect(appConnections({}).list()).rejects.toThrow(/project key/);
    const connections = appConnections({ COMPOSIO_API_KEY: "test" });
    await expect(connections.connect("unknown")).rejects.toThrow(/Slack/);
    mock.authorize.mockResolvedValue({ redirectUrl: "https://evil.example/collect" });
    await expect(connections.connect("slack")).rejects.toThrow(/authorization/);
    mock.authorize.mockResolvedValue({ redirectUrl: "https://connect.composio.dev/link/test" });
    expect(await connections.connect("slack")).toBe("https://connect.composio.dev/link/test");
  });
});
