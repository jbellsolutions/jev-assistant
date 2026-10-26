/** The panel's 📎: files picked or dropped, uploaded to the companion, sent with the next message. */

export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface Chip {
  key: string;
  name: string;
  state: "uploading" | "ready" | "error";
  id?: string;
  error?: string;
}

/** Which of these files can join the ones already attached, and why the rest can't. */
export function admit(existing: number, files: Array<{ name: string; size: number }>): { take: number[]; refused: string[] } {
  const take: number[] = [];
  const refused: string[] = [];
  files.forEach((f, i) => {
    if (existing + take.length >= MAX_FILES) refused.push(`${f.name}: ${MAX_FILES} files per message at most`);
    else if (f.size > MAX_FILE_BYTES) refused.push(`${f.name} is over 25 MB`);
    else if (f.size === 0) refused.push(`${f.name} is empty`);
    else take.push(i);
  });
  return { take, refused };
}

/** Enter sends; Shift+Enter is a new line; typing through an input method never sends. */
export function keyAction(e: { key: string; shiftKey: boolean; isComposing?: boolean }): "send" | null {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing ? "send" : null;
}

/** What goes out with the message: only files that finished uploading. */
export function readyFiles(chips: Chip[]): Array<{ id: string; name: string }> {
  return chips.filter((c) => c.state === "ready" && c.id).map((c) => ({ id: c.id!, name: c.name }));
}

export async function uploadFile(url: string, file: File): Promise<{ id: string; name: string } | { error: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "x-file-name": encodeURIComponent(file.name), "content-type": file.type || "application/octet-stream" }, body: file });
    const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; error?: string };
    if (!res.ok || !body.id) return { error: body.error ?? `upload failed (HTTP ${res.status})` };
    return { id: body.id, name: body.name ?? file.name };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
