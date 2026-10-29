/** Real React hook + Web Audio in Chromium, with a synthetic room and no physical mic. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const result = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {useLiveVoice} from './client/src/hooks/useLiveVoice'; import {VoiceInput} from './client/src/components/VoiceInput'; const transport={httpUrl:p=>p}; function App(){const voice=useLiveVoice(transport,'local',false,false);return <><button onClick={()=>void voice.start()}>Start</button><button onClick={()=>void voice.stop()}>Stop</button><p data-state>{voice.state}</p><p role="alert">{voice.error}</p><VoiceInput voice={voice}/></>} createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: "tsx" }, alias: { "livekit-client": `${root}/test/fixtures/voice-room.ts` }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic" });
const server = createServer((req, res) => {
  if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(result.outputFiles[0].text); }
  else if (req.url?.startsWith("/assistant/")) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(req.url.endsWith("/token") ? { url: "wss://fixture.invalid", token: "fixture", room: "fixture" } : { state: "ready" })); }
  else res.end('<html><body><div id="root"></div><script src="/app.js"></script></body></html>');
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage(); const errors = []; page.on("pageerror", e => errors.push(e.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base); await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByText("Microphone is receiving sound.", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-state]').innerText(), "on");
  assert.ok(await page.getByRole("meter").evaluate(el => el.value) > 0);
  await page.getByRole("button", { name: "Retry microphone", exact: true }).click();
  await page.getByText("Microphone is receiving sound.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  assert.equal(await page.getByRole("meter").count(), 0);
  await page.goto(`${base}?silent`); await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByText("No microphone sound detected. Check your input or retry the microphone.", { exact: true }).waitFor({ timeout: 12000 });
  assert.equal(await page.getByRole("meter").evaluate(el => el.value), 0);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  for (const [mode, message] of [["missing", "The microphone did not start. Choose an input and try again."], ["denied", "Microphone access was denied."]]) {
    await page.goto(`${base}?${mode}`); await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: message }).waitFor();
    assert.equal(await page.locator('[data-state]').innerText(), "off");
  }
  await page.addInitScript(() => {
    const Native = window.AudioContext; let created = 0;
    window.AudioContext = class extends Native {
      constructor(...args) { super(...args); this.meter = ++created === 2; }
      get state() { return this.meter ? "suspended" : super.state; }
      resume() { return this.meter ? new Promise(() => {}) : super.resume(); }
    };
  });
  await page.goto(`${base}?suspended`); await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByText("Tap to enable sound to check microphone input.", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-state]').innerText(), "on");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  assert.deepEqual(errors, []);
  console.log("PASS: real React voice input shows synthetic sound, detects silence, recreates capture on retry, cleans up on stop and rejects missing/denied microphones and avoids hanging on a suspended meter. No physical microphone or provider calls.");
} finally { await browser.close(); await new Promise(r => server.close(r)); }
