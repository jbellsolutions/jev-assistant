import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractText } from "../core/elements.js";

/** Runs the real in-page read script in headless Chromium against small HTML fixtures. */
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30000);
afterAll(async () => {
  await browser?.close();
});

async function readFrom(html: string, max = 12_000) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
  const out = await extractText({ evaluate: (src) => page.evaluate(src) }, max);
  await page.close();
  return out;
}

describe("READ_SCRIPT in a real DOM", () => {
  it("returns prose and strips scripts, styles, nav and footer chrome", async () => {
    const out = await readFrom(`
      <nav><a href="/x">Home</a><a href="/y">Pricing</a></nav>
      <script>var secret = "do not read me";</script>
      <style>.a { color: red }</style>
      <main><h1>Acme Widgets</h1><p>The Pro plan costs $42 per month.</p></main>
      <footer>© 2026 Acme, all rights reserved</footer>
    `);
    expect(out.text).toContain("Acme Widgets");
    expect(out.text).toContain("$42 per month");
    // the whole point: the answer isn't buried in menu labels and copyright lines
    expect(out.text).not.toContain("do not read me");
    expect(out.text).not.toContain("color: red");
    expect(out.text).not.toContain("all rights reserved");
    expect(out.text).not.toContain("Pricing");
  });

  it("prefers <main> over the rest of the body", async () => {
    const out = await readFrom(`<div>sidebar junk</div><main><p>the real content</p></main>`);
    expect(out.text).toBe("the real content");
  });

  it("skips hidden and aria-hidden nodes", async () => {
    const out = await readFrom(`
      <main>
        <p>visible</p>
        <p style="display:none">hidden by css</p>
        <p style="visibility:hidden">invisible</p>
        <p aria-hidden="true">hidden from a11y</p>
      </main>`);
    expect(out.text).toBe("visible");
  });

  it("keeps block structure as newlines rather than running text together", async () => {
    const out = await readFrom(`<main><h1>Title</h1><p>One.</p><p>Two.</p><ul><li>a</li><li>b</li></ul></main>`);
    expect(out.text.split("\n").filter(Boolean)).toEqual(["Title", "One.", "Two.", "a", "b"]);
  });

  it("caps at max and reports the true length so a caller knows what it is missing", async () => {
    const body = "x".repeat(500);
    const out = await readFrom(`<main><p>${body}</p></main>`, 100);
    expect(out.text).toHaveLength(100);
    expect(out.truncated).toBe(true);
    expect(out.chars).toBe(500);
  });

  it("reports untruncated when the page fits", async () => {
    const out = await readFrom(`<main><p>short</p></main>`, 100);
    expect(out).toEqual({ text: "short", truncated: false, chars: 5 });
  });

  it("collapses runs of whitespace from prettified markup", async () => {
    const out = await readFrom(`<main><p>a     lot\n\n\n  of      space</p></main>`);
    expect(out.text).toBe("a lot of space");
  });

  it("survives a page with no body content", async () => {
    const out = await readFrom("");
    expect(out).toEqual({ text: "", truncated: false, chars: 0 });
  });
});
