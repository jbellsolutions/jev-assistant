/** Keeps the brain's history short. Every mac_read / mac_act returns the whole window again —
 *  every element with its id, plus the text on screen — and each step resends all of it. Live
 *  2026-09-25 that grew one Slack run from 2.5k to 23k input tokens a step. Only the latest reads
 *  are worth acting on (element ids from older ones are stale anyway), so older results keep their
 *  first line — what was done — and what was on screen, and lose the element list. */
import type { ModelMessage } from "ai";

/** Tools whose results are screens: long, and superseded by the next one. */
export const SCREEN_TOOLS = new Set(["mac_read", "mac_act", "chrome"]);
/** How many of the most recent screens stay whole. */
export const KEEP_WHOLE = 2;
/** How much of an older screen survives. */
export const OLD_SCREEN_CHARS = 1000;
const SHORTENED = "(older screen, shortened — its element ids are stale; read again to act)";

export function shortenScreen(text: string, cap = OLD_SCREEN_CHARS): string {
  if (text.includes(SHORTENED)) return text;
  const first = text.split("\n", 1)[0] ?? "";
  const at = text.indexOf("\nText on screen:\n");
  const onScreen = at === -1 ? "" : text.slice(at + 1);
  const body = onScreen ? `${first}\n${onScreen}` : first;
  const kept = body.length > cap ? `${body.slice(0, cap)}…` : body;
  return `${kept}\n${SHORTENED}`;
}

/** Screenshots (the orgo tool) are an image each — ~1k+ tokens, and useless once the screen has
 *  changed. Only the newest `keep` stay images; older ones become a line saying one was there. */
export const KEEP_IMAGES = 1;
const OLD_IMAGE = "(older screenshot removed — look again if you need the screen)";

export function compactImages(messages: ModelMessage[], keep = KEEP_IMAGES): ModelMessage[] {
  const at: Array<[number, number, number]> = [];
  messages.forEach((m, i) => {
    if (m.role !== "tool") return;
    m.content.forEach((p, j) => {
      if (p.type !== "tool-result" || p.output.type !== "content") return;
      p.output.value.forEach((part, k) => {
        if (part.type === "file" || part.type === "image-data" || part.type === "file-data") at.push([i, j, k]);
      });
    });
  });
  const old = at.slice(0, Math.max(0, at.length - keep));
  if (!old.length) return messages;
  const out = messages.map((m) => (m.role === "tool" ? { ...m, content: m.content.map((p) => (p.type === "tool-result" && p.output.type === "content" ? { ...p, output: { ...p.output, value: [...p.output.value] } } : p)) } : m)) as ModelMessage[];
  for (const [i, j, k] of old) {
    const p = (out[i] as Extract<ModelMessage, { role: "tool" }>).content[j]!;
    if (p.type === "tool-result" && p.output.type === "content") p.output.value[k] = { type: "text", text: OLD_IMAGE };
  }
  return out;
}

/** Shortens every screen result except the last `keep`. Returns the same array when nothing
 *  changed, so a caller can tell. */
export function compactScreens(messages: ModelMessage[], keep = KEEP_WHOLE): ModelMessage[] {
  const at: Array<[number, number]> = [];
  messages.forEach((m, i) => {
    if (m.role !== "tool") return;
    m.content.forEach((p, j) => {
      if (p.type === "tool-result" && SCREEN_TOOLS.has(p.toolName) && p.output.type === "text") at.push([i, j]);
    });
  });
  const old = at.slice(0, Math.max(0, at.length - keep));
  if (!old.length) return messages;
  let changed = false;
  const out = messages.map((m) => ({ ...m })) as ModelMessage[];
  for (const [i, j] of old) {
    const m = out[i] as Extract<ModelMessage, { role: "tool" }>;
    const content = [...m.content];
    const p = content[j]!;
    if (p.type !== "tool-result" || p.output.type !== "text") continue;
    const short = shortenScreen(p.output.value);
    if (short === p.output.value) continue;
    content[j] = { ...p, output: { ...p.output, value: short } };
    out[i] = { ...m, content };
    changed = true;
  }
  return changed ? out : messages;
}
