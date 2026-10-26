/** Files the user hands Jev — a charter, a project plan, a screenshot — dropped on the panel or picked
 *  with 📎 (v11.5 M5).
 *
 *  Stored under ~/.jev/attachments/<id>/ (0700 dir, 0600 file) and read on demand: text as it is,
 *  PDF through unpdf, .docx through mammoth, images handed to the lead as images. Anything else is
 *  refused by name, with what to do instead, at upload — never accepted and silently ignored. */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type Request, type RequestHandler, Router, raw } from "express";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
/** What the lead gets in the message itself; read_doc pages through the rest. */
export const DOC_INLINE_CHARS = 40_000;

const TEXT = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".log"]);
const IMAGE: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const EXPORT_HINT: Record<string, string> = {
  ".pages": "export it as PDF",
  ".key": "export it as PDF",
  ".numbers": "export it as CSV",
  ".doc": "save it as .docx or PDF",
  ".xlsx": "export the sheet as CSV",
  ".xls": "export the sheet as CSV",
  ".pptx": "export it as PDF",
  ".rtf": "save it as .docx or PDF",
};

export type AttachmentKind = "text" | "pdf" | "docx" | "image";

export interface AttachmentRef {
  id: string;
  name: string;
}

export interface Attachment extends AttachmentRef {
  kind: AttachmentKind;
  size: number;
  mime: string;
  at: string;
}

export type AttachmentContent = { kind: "text"; text: string } | { kind: "image"; mime: string; base64: string };

/** Which kind a file is, by its name — or why it can't be read. */
export function kindOf(name: string): { kind: AttachmentKind; mime: string } | { refused: string } {
  const ext = path.extname(name).toLowerCase();
  if (TEXT.has(ext)) return { kind: "text", mime: "text/plain" };
  if (ext === ".pdf") return { kind: "pdf", mime: "application/pdf" };
  if (ext === ".docx") return { kind: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  if (IMAGE[ext]) return { kind: "image", mime: IMAGE[ext]! };
  const hint = EXPORT_HINT[ext];
  return { refused: `Can't read ${ext || "files without an extension"}${hint ? ` — ${hint}` : " — attach text, Markdown, CSV, JSON, PDF, .docx or an image"}.` };
}

export function defaultAttachmentDir(): string {
  return path.join(process.env.JEV_HOME ?? path.join(homedir(), ".jev"), "attachments");
}

export class AttachmentStore {
  private readonly texts = new Map<string, string>();

  constructor(private readonly dir = defaultAttachmentDir()) {}

  save(name: string, bytes: Buffer): Attachment | { refused: string } {
    const clean = path.basename(name).replace(/[^\w .()+-]/g, "_").slice(0, 120) || "file";
    const kind = kindOf(clean);
    if ("refused" in kind) return kind;
    if (bytes.length > MAX_ATTACHMENT_BYTES) return { refused: `${clean} is over 25 MB.` };
    const id = `att_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
    const folder = path.join(this.dir, id);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(folder, clean), bytes, { mode: 0o600 });
    const meta: Attachment = { id, name: clean, kind: kind.kind, mime: kind.mime, size: bytes.length, at: new Date().toISOString() };
    writeFileSync(path.join(folder, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
    return meta;
  }

  get(id: string): Attachment | null {
    if (!/^att_[a-z0-9]+$/.test(id)) return null;
    const file = path.join(this.dir, id, "meta.json");
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Attachment;
    } catch {
      return null;
    }
  }

  /** The file's content, read once and kept for this process. */
  async content(id: string): Promise<AttachmentContent> {
    const meta = this.get(id);
    if (!meta) throw new Error(`No attachment ${id}`);
    const bytes = readFileSync(path.join(this.dir, id, meta.name));
    if (meta.kind === "image") return { kind: "image", mime: meta.mime, base64: bytes.toString("base64") };
    const cached = this.texts.get(id);
    if (cached !== undefined) return { kind: "text", text: cached };
    const text = await extractText(meta.kind, bytes);
    this.texts.set(id, text);
    return { kind: "text", text };
  }

  /** Every attachment on disk, newest first (for tests and housekeeping). */
  list(): Attachment[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .map((id) => this.get(id))
      .filter((a): a is Attachment => !!a)
      .sort((a, b) => b.at.localeCompare(a.at));
  }
}

export async function extractText(kind: AttachmentKind, bytes: Buffer): Promise<string> {
  if (kind === "text") return bytes.toString("utf8");
  if (kind === "pdf") {
    const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await pdfText(pdf, { mergePages: true });
    return String(text);
  }
  if (kind === "docx") {
    const mammoth = await import("mammoth");
    const { value } = await (mammoth.default ?? mammoth).extractRawText({ buffer: bytes });
    return value;
  }
  throw new Error("An image has no text to extract.");
}

/** Headings, as a map of a long document: Markdown #, numbered sections, short ALL-CAPS lines. */
export function outline(text: string, max = 60): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.length > 100) continue;
    if (/^#{1,4}\s+\S/.test(line) || /^(\d+(\.\d+)*[.)]?|[IVX]+\.)\s+[A-Z]/.test(line) || (/^[A-Z][A-Z0-9 &/,:'-]{3,}$/.test(line) && /[A-Z]{3}/.test(line))) out.push(line.replace(/^#+\s+/, ""));
    if (out.length >= max) break;
  }
  return out;
}

/** How a document goes into the lead's message: whole when short, else its outline and the start. */
export function inlineDoc(name: string, id: string, text: string, limit = DOC_INLINE_CHARS): string {
  if (text.length <= limit) return `--- ${name} (${id}) ---\n${text}\n--- end of ${name} ---`;
  const heads = outline(text);
  return [
    `--- ${name} (${id}) — ${text.length.toLocaleString("en-US")} characters; the first ${limit.toLocaleString("en-US")} below. read_doc {id: "${id}", from: ${limit}} reads on. ---`,
    heads.length ? `Outline:\n${heads.map((h) => `- ${h}`).join("\n")}\n` : "",
    text.slice(0, limit),
    `--- (continues: read_doc from ${limit}) ---`,
  ].join("\n");
}

/** POST /attachments — raw bytes, the name in `x-file-name`. Allowed like the panel's own socket:
 *  a page from an allowed origin, or anything presenting the bearer token. */
export function attachmentRoute(store: AttachmentStore, allowed: (req: Request) => boolean, maxBytes = MAX_ATTACHMENT_BYTES): Router {
  const r = Router();
  const gate: RequestHandler = (req, res, next) => (allowed(req) ? next() : void res.status(401).json({ error: "not allowed" }));
  r.post("/attachments", gate, raw({ type: () => true, limit: maxBytes }), (req, res) => {
    const name = decodeURIComponent(String(req.header("x-file-name") ?? "")).trim();
    if (!name) return void res.status(400).json({ error: "x-file-name is required" });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!body.length) return void res.status(400).json({ error: `${name} is empty` });
    const saved = store.save(name, body);
    if ("refused" in saved) return void res.status(415).json({ error: saved.refused });
    res.json({ id: saved.id, name: saved.name, kind: saved.kind, size: saved.size });
  });
  // express.raw's own "too large" error, as a sentence the panel can show
  r.use(((err, _req, res, next) => {
    if ((err as { type?: string }).type === "entity.too.large") return void res.status(413).json({ error: "That file is over 25 MB." });
    next(err);
  }) as import("express").ErrorRequestHandler);
  return r;
}

type UserPart = { type: "text"; text: string } | { type: "image"; image: string; mediaType: string };

/** the user's words plus his files, as one user message: documents inline (or their outline and start),
 *  images as images. A file that can't be read is named in the message, not dropped. */
export async function withAttachments(store: AttachmentStore, text: string, refs: AttachmentRef[]): Promise<string | UserPart[]> {
  if (!refs.length) return text;
  const docs: string[] = [];
  const images: UserPart[] = [];
  for (const ref of refs) {
    try {
      const c = await store.content(ref.id);
      if (c.kind === "image") {
        images.push({ type: "image", image: c.base64, mediaType: c.mime });
        docs.push(`--- ${ref.name} (${ref.id}): an image, attached below ---`);
      } else docs.push(inlineDoc(ref.name, ref.id, c.text));
    } catch (err) {
      docs.push(`--- ${ref.name} (${ref.id}): couldn't be read (${err instanceof Error ? err.message : String(err)}) ---`);
    }
  }
  const body = `${text}\n\nthe user attached ${refs.length === 1 ? "a file" : `${refs.length} files`}:\n${docs.join("\n\n")}`;
  return images.length ? [{ type: "text", text: body }, ...images] : body;
}
