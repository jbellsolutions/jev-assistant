/** The in-page readable-text extractor, shared by every DOM-based executor: Playwright evaluates
 *  it as a string, the Chrome bridge bundles it into its content script at build time.
 *
 *  Kept as a plain JS source string (not a TS function) for the same reason as page-script.ts:
 *  bundlers/loaders such as tsx must not inject helpers (`__name`) that don't exist in the page.
 *
 *  It walks the LIVE DOM rather than cloning and reading innerText — a detached clone has no
 *  layout, so innerText comes back empty there. Walking also lets us drop chrome (nav, footer,
 *  script) and hidden nodes as we go, which is what keeps the result readable instead of a wall
 *  of menu labels.
 *  Signature: (max: number) => { text: string; truncated: boolean; chars: number } */
export const READ_SCRIPT = String.raw`(max) => {
  const DROP = new Set(["SCRIPT","STYLE","NOSCRIPT","SVG","CANVAS","IFRAME","NAV","FOOTER","ASIDE","TEMPLATE","BUTTON","SELECT"]);
  const BLOCK = new Set(["P","DIV","LI","TR","SECTION","ARTICLE","H1","H2","H3","H4","H5","H6",
    "BLOCKQUOTE","PRE","TD","TH","BR","FIGCAPTION","DD","DT","MAIN","HEADER","FORM","HR","UL","OL","TABLE"]);
  const root = document.querySelector("main, article, [role='main']") || document.body;
  if (!root) return { text: "", truncated: false, chars: 0 };

  const parts = [];
  const walk = (node) => {
    if (node.nodeType === 3) {
      const t = node.nodeValue;
      // newlines inside a text node are just source formatting — HTML collapses them. Only the
      // block boundaries below are real structure, so flatten here and let them do the breaking.
      if (t && t.trim()) parts.push(t.replace(/\s+/g, " "));
      return;
    }
    if (node.nodeType !== 1) return;
    if (DROP.has(node.tagName)) return;
    if (node.getAttribute && node.getAttribute("aria-hidden") === "true") return;
    try {
      const st = getComputedStyle(node);
      if (st && (st.display === "none" || st.visibility === "hidden")) return;
    } catch (e) { /* detached or cross-origin: keep walking */ }
    const block = BLOCK.has(node.tagName);
    if (block) parts.push("\n");
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) walk(kids[i]);
    if (block) parts.push("\n");
  };
  walk(root);

  const text = parts.join("")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const chars = text.length;
  return { text: text.slice(0, max), truncated: chars > max, chars: chars };
}`;
