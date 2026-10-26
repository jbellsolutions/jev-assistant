import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import JSZip from "jszip";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import type { BrainEvent, BrainRun } from "../core/brain.js";
import { AgentBrain } from "../server/brain/agent.js";
import { LeadBrain } from "../server/brain/lead.js";
import { TaskStore } from "../server/brain/task-store.js";
import type { Hands } from "../server/brain/tools.js";
import { AttachmentStore, attachmentRoute, inlineDoc, kindOf, outline } from "../server/attachments.js";
import { admit, keyAction, readyFiles } from "../client/src/attach.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "jev-att-"));

/** A one-page PDF with real text, written by hand (no PDF library needed). */
function pdfWith(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function docxWith(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

const servers: Array<{ close(): void }> = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function serve(store: AttachmentStore, maxBytes?: number) {
  const app = express();
  app.use(attachmentRoute(store, (req) => req.header("origin") === "http://127.0.0.1:3111" || req.header("authorization") === "Bearer tok", maxBytes));
  const server = app.listen(0);
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/attachments`;
  const post = (name: string, body: Buffer, headers: Record<string, string> = { origin: "http://127.0.0.1:3111" }) => fetch(url, { method: "POST", headers: { "x-file-name": encodeURIComponent(name), ...headers }, body: new Uint8Array(body) });
  return { post };
}

describe("the upload route", () => {
  it("takes a file from the panel's own origin or with the token, and nothing else", async () => {
    const { post } = await serve(new AttachmentStore(tmp()));
    expect((await post("plan.md", Buffer.from("# Plan"), {})).status).toBe(401);
    expect((await post("plan.md", Buffer.from("# Plan"), { origin: "https://evil.example" })).status).toBe(401);
    expect((await post("plan.md", Buffer.from("# Plan"), { authorization: "Bearer tok" })).status).toBe(200);
    const ok = await post("plan.md", Buffer.from("# Plan"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ name: "plan.md", kind: "text" });
  });

  it("refuses by name what it can't read, and says what to do; too large is a 413", async () => {
    const { post } = await serve(new AttachmentStore(tmp()), 1024);
    const pages = await post("charter.pages", Buffer.from("x"));
    expect(pages.status).toBe(415);
    expect((await pages.json()).error).toMatch(/Can't read \.pages — export it as PDF/);
    expect((await post("big.txt", Buffer.alloc(4096, 97))).status).toBe(413);
  });
});

describe("reading what was attached", () => {
  it("text, Markdown, PDF and .docx all come back as text; a file lands 0600 in its own folder", async () => {
    const store = new AttachmentStore(tmp());
    const md = store.save("plan.md", Buffer.from("# Phase 1\nShip the lead."));
    const pdf = store.save("charter.pdf", pdfWith("Charter: automate Salesforce onboarding"));
    const docx = store.save("plan.docx", await docxWith(["Phase 1: create the External Client App", "Phase 2: sync leads"]));
    for (const a of [md, pdf, docx]) if ("refused" in a) throw new Error(a.refused);
    expect(await store.content((md as { id: string }).id)).toEqual({ kind: "text", text: "# Phase 1\nShip the lead." });
    expect((await store.content((pdf as { id: string }).id)) as { text: string }).toMatchObject({ text: expect.stringContaining("Charter: automate Salesforce onboarding") });
    expect(((await store.content((docx as { id: string }).id)) as { text: string }).text).toContain("Phase 2: sync leads");
    expect(kindOf("shot.PNG")).toMatchObject({ kind: "image", mime: "image/png" });
  });

  it("a long document goes in as its outline and its start, and says how to read on", () => {
    const text = `# Charter\n${"a".repeat(30)}\n## Phase 1\n${"b".repeat(50_000)}\n## Phase 2\nsync`;
    const doc = inlineDoc("charter.md", "att_x", text);
    expect(doc).toContain("Outline:\n- Charter\n- Phase 1\n- Phase 2");
    expect(doc).toContain('read_doc {id: "att_x", from: 40000}');
    expect(doc.length).toBeLessThan(41_000);
    expect(outline("1. Scope\nplain words\nDELIVERABLES")).toEqual(["1. Scope", "DELIVERABLES"]);
  });
});

describe("the lead reads it and keeps it with the task", () => {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const call = (toolName: string, input: unknown) => ({ content: [{ type: "tool-call", toolCallId: `${toolName}${Math.random()}`, toolName, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage, warnings: [] });
  const say = (text: string) => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] });
  const scripted = (steps: unknown[]) => {
    let i = 0;
    return new MockLanguageModelV4({ doGenerate: async () => steps[Math.min(i++, steps.length - 1)] as never });
  };
  const collect = async (r: BrainRun) => {
    const out: BrainEvent[] = [];
    for await (const e of r.events) out.push(e);
    return out;
  };

  it("the charter is in the lead's message, joins the task it starts, and read_doc pages through the rest", async () => {
    const store = new AttachmentStore(tmp());
    const long = `# Charter\nGoal: onboard Salesforce leads.\n${"x".repeat(45_000)}\nFINAL CLAUSE: keys go in ~/.env.local`;
    const doc = store.save("charter.md", Buffer.from(long)) as { id: string; name: string };
    const worker = new AgentBrain({ model: scripted([say("STATUS: done\nok")]), modelId: "w", hands: { chrome: null, mac: null, computer: null } as Hands, instructions: () => "w" });
    const leadModel = scripted([call("read_doc", { id: doc.id, from: 40_000 }), call("work", { goal: "Do phase 1", done_when: "done" }), say("Phase 1 is done — the charter says the keys go in ~/.env.local. Shall I start phase 2?")]);
    const tasks = new TaskStore(null);
    const lead = new LeadBrain({ model: leadModel, modelId: "l", worker, tasks, attachments: store });
    const events = await collect(await lead.send("here's the plan — do phase 1", { attachments: [{ id: doc.id, name: doc.name }] }));
    expect(events.at(-1)).toMatchObject({ kind: "completed" });
    const first = JSON.stringify(leadModel.doGenerateCalls[0]!.prompt);
    expect(first).toContain("Goal: onboard Salesforce leads.");
    expect(first).toContain("the user attached a file");
    expect(JSON.stringify(leadModel.doGenerateCalls[1]!.prompt)).toContain("FINAL CLAUSE: keys go in ~/.env.local");
    expect(tasks.current?.docs).toEqual([{ id: doc.id, name: "charter.md" }]);
    // a later nudge in that task still has it in view
    expect(tasks.brief()).toContain(`charter.md (${doc.id})`);
  });

  it("an image goes to the lead as an image", async () => {
    const store = new AttachmentStore(tmp());
    const png = store.save("shot.png", Buffer.from("89504e470d0a1a0a", "hex")) as { id: string; name: string };
    const leadModel = scripted([say("I see it.")]);
    const worker = new AgentBrain({ model: scripted([say("x")]), modelId: "w", hands: { chrome: null, mac: null, computer: null } as Hands, instructions: () => "w" });
    await collect(await new LeadBrain({ model: leadModel, modelId: "l", worker, tasks: new TaskStore(null), attachments: store }).send("what's this?", { attachments: [png] }));
    const user = leadModel.doGenerateCalls[0]!.prompt.find((m) => m.role === "user")!;
    expect(JSON.stringify(user.content)).toContain('"mediaType":"image/png"');
  });
});

describe("the panel's chat box", () => {
  it("Enter sends, Shift+Enter is a new line, composing never sends", () => {
    expect(keyAction({ key: "Enter", shiftKey: false })).toBe("send");
    expect(keyAction({ key: "Enter", shiftKey: true })).toBeNull();
    expect(keyAction({ key: "Enter", shiftKey: false, isComposing: true })).toBeNull();
  });

  it("five files a message, 25 MB each; only finished uploads go out", () => {
    const f = (name: string, size = 10) => ({ name, size });
    expect(admit(4, [f("a"), f("b")])).toEqual({ take: [0], refused: ["b: 5 files per message at most"] });
    expect(admit(0, [f("big", 26 * 1024 * 1024)]).refused[0]).toMatch(/over 25 MB/);
    expect(readyFiles([{ key: "1", name: "a", state: "ready", id: "att_1" }, { key: "2", name: "b", state: "uploading" }])).toEqual([{ id: "att_1", name: "a" }]);
  });
});
