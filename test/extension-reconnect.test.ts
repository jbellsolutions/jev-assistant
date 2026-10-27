import { buildSync } from "esbuild";
import vm from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
const code = buildSync({ entryPoints: ["extension/background.ts"], bundle: true, write: false, platform: "browser", format: "iife", logLevel: "silent" }).outputFiles[0]!.text;
afterEach(() => vi.useRealTimers());
async function setup() {
  vi.useFakeTimers();
  const events: Record<string, (...args: unknown[]) => unknown> = {};
  const listener = (key: string) => ({ addListener: (fn: (...args: unknown[]) => unknown) => { events[key] = fn; } });
  const badge = vi.fn();
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0; onopen?: () => Promise<void>; onclose?: () => void; onerror?: () => void;
    send = vi.fn(); close = vi.fn(() => { this.readyState = 3; });
    constructor(_url: string) { sockets.push(this); }
    async open() { this.readyState = 1; await this.onopen?.(); }
    ended() { this.readyState = 3; this.onclose?.(); }
  }
  const fetchFake = vi.fn(async () => ({ ok: true, json: async () => ({ token: "ok" }) }));
  const chrome = {
    storage: { local: { get: async () => ({ url: "ws://127.0.0.1:3111/ws/bridge", token: "local-test" }) }, session: { get: async () => ({}) }, onChanged: listener("settings") },
    tabs: { query: async () => [], onActivated: listener("tab"), onUpdated: listener("update") },
    windows: { onFocusChanged: listener("focus") },
    action: { setBadgeText: badge, setBadgeBackgroundColor: vi.fn(), setTitle: vi.fn() },
    runtime: { getManifest: () => ({ version: "0.3.1" }), onStartup: listener("startup"), onInstalled: listener("install") },
    alarms: { create: vi.fn(), onAlarm: listener("alarm") },
  };
  vm.runInNewContext(code, { chrome, WebSocket: FakeSocket, fetch: fetchFake, URL, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, console });
  await vi.advanceTimersByTimeAsync(0);
  return { events, sockets, badge, fetchFake };
}
it("a late close from an old socket cannot clear the new connection or its keepalive", async () => {
  const { events, sockets, badge } = await setup(); await sockets[0]!.open();
  events.settings!({}, "local"); await vi.advanceTimersByTimeAsync(0); await sockets[1]!.open();
  badge.mockClear(); sockets[0]!.ended();
  expect(badge).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20000);
  expect(sockets[1]!.send.mock.calls.map(([data]) => JSON.parse(data))).toContainEqual({ type: "pong" });
  expect(sockets).toHaveLength(2);
});
it("deduplicates retries and reconnects after the companion restarts", async () => {
  const { events, sockets } = await setup(); await sockets[0]!.open(); sockets[0]!.ended(); sockets[0]!.ended();
  await vi.advanceTimersByTimeAsync(999); expect(sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(sockets).toHaveLength(2);
  await sockets[1]!.open(); events.alarm!(); events.startup!();
  await vi.advanceTimersByTimeAsync(0); expect(sockets).toHaveLength(2);
});
it("closes a socket that gets stuck during opening so the close event can retry", async () => {
  const { sockets, fetchFake } = await setup();
  expect(fetchFake.mock.calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5000); expect(sockets[0]!.close).toHaveBeenCalledOnce();
  sockets[0]!.ended(); await vi.advanceTimersByTimeAsync(1000); expect(sockets).toHaveLength(2);
});
