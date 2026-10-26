/** esbuild plugin: `import { listElements } from "virtual:page-script"` (and `readPage` from
 *  "virtual:read-script") becomes the core script inlined as real code, so the content script
 *  needs no eval — page CSPs forbid it. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../core/page-script.ts", import.meta.url));
const READ_SOURCE = fileURLToPath(new URL("../core/read-script.ts", import.meta.url));

/** Pull a raw template literal out of a core script without executing TypeScript. */
function lift(file, name) {
  const text = readFileSync(file, "utf8");
  const m = new RegExp(`${name} = String\\.raw\`([\\s\\S]*?)\`;\\s*$`, "m").exec(text);
  if (!m) throw new Error(`${name} not found in ${file}`);
  return m[1];
}

export function pageScriptSource(file = SOURCE) {
  return lift(file, "PAGE_SCRIPT");
}

export function readScriptSource(file = READ_SOURCE) {
  return lift(file, "READ_SCRIPT");
}

const VIRTUALS = {
  "virtual:page-script": () => ({ code: `export const listElements = ${pageScriptSource()};`, watch: SOURCE }),
  "virtual:read-script": () => ({ code: `export const readPage = ${readScriptSource()};`, watch: READ_SOURCE }),
};

export function pageScriptPlugin() {
  return {
    name: "jev-page-script",
    setup(build) {
      build.onResolve({ filter: /^virtual:(page|read)-script$/ }, (args) => ({ path: args.path, namespace: "jev-virtual" }));
      build.onLoad({ filter: /.*/, namespace: "jev-virtual" }, (args) => {
        const make = VIRTUALS[args.path];
        if (!make) throw new Error(`unknown virtual module ${args.path}`);
        const { code, watch } = make();
        return { contents: code, loader: "js", watchFiles: [watch] };
      });
    },
  };
}
