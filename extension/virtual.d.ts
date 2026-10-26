declare module "virtual:page-script" {
  /** The core page script, inlined at build time: (max) => RawElement[] */
  export const listElements: (max: number) => unknown[];
}

declare module "virtual:read-script" {
  import type { RawPageText } from "../core/remote.js";
  export function readPage(max: number): RawPageText;
}
