// Reading a PDF so a model can understand it. The fixtures are what pdf.js really returned for PDFs Chromium made from
// HTML: Persian text as separate glyphs in presentation forms in visual order, a ligature as an item of its own, a
// table, and a line that mixes the two scripts. Gluing those items together in stream order gives noise; laid out
// again they read as the text that was typed.
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { load, eq, ok, count } from "./harness-helpers.mjs";

const h = await load("test/harness-pdf-entry.ts");
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(path.join(here, "fixtures", "pdf-items.json"), "utf8"));

// ── a page laid out again ─────────────────────────────────────────────────
{
  const english = h.layoutPageText(fixtures.english1);
  eq(english, "Quarterly Report\n\nRevenue grew 12% quarter over quarter, driven by the second half of\nthe year. The plan for next year keeps costs flat.\n\nSecond paragraph on the first page.", "English: lines, paragraphs, and a ligature that is an item of its own (\"fl\" + \"at.\")");
  eq(h.layoutPageText(fixtures.english2), "Appendix\n\nTable of results follows.\n\nRegion | Revenue | Growth\n\nNorth | 1,200 | 8%\n\nSouth | 950 | 15%", "a table keeps its columns");

  const persian = h.layoutPageText(fixtures.persian1);
  const lines = persian.split("\n");
  eq(lines[0], "گزارش فصلی", "Persian: a heading comes out as the words typed, not as glyphs from the right");
  ok(persian.includes("درآمد در فصل دوم نسبت به فصل اول ۱۲ درصد رشد کرد و برنامهٔ سال آینده"), "…and a paragraph in reading order, with its digits and its hamza on the right letter");
  ok(persian.includes("«چگونه»، «پژوهش» و «گفتگو»"), "…and quotation marks that are not reversed");
  ok(!/[ﭐ-﷿ﹰ-﻿]/.test(persian), "…in letters, not in presentation forms");
  ok(!persian.includes("ی ﻠ") && !/(?:^| )[ء-ي] [ء-ي] [ء-ي] /.test(persian), "…and not as single letters with spaces between them");

  const second = h.layoutPageText(fixtures.persian2);
  ok(second.includes("نام شرکت Acme و مبلغ 1,200 دلار در میان متن"), "Persian with Latin words and numbers inside keeps their place");

  const mixed = h.layoutPageText(fixtures.mixed1);
  ok(mixed.startsWith("The word Agenter appears in متن فارسی با کلمهٔ Obsidian در وسط آن and"), "a line that switches script twice reads in order, without stray separators");
  ok(!mixed.includes("|"), "…and without a column where there is none");
}

// ── judging text ──────────────────────────────────────────────────────────
{
  ok(h.judgeText("Revenue grew twelve percent in the second quarter of the year.").readable, "ordinary text is text");
  ok(h.judgeText("Chapter 1").readable, "a few clean characters are text");
  ok(!h.judgeText("").readable, "nothing is not");
  ok(!h.judgeText("").readable, "private-use characters are a font without a map");
  ok(!h.judgeText("(cid:12)(cid:45)(cid:7)(cid:9) (cid:88)(cid:90) text").readable, "(cid:n) markers are too");
  ok(!h.judgeText("���� ����� a").readable, "replacement marks are");
}

// ── page ranges ───────────────────────────────────────────────────────────
{
  eq(h.parsePageRanges("1-3, 7, 10-", 12), [1, 2, 3, 7, 10, 11, 12], "ranges, singles and an open end");
  eq(h.parsePageRanges("all", 4), [1, 2, 3, 4], "all");
  eq(h.parsePageRanges("0, 9-20, abc, 3", 10), [3, 9, 10], "pages that do not exist are dropped");
  eq(h.parsePageRanges("5-3", 10), [3, 4, 5], "a backwards range is forgiven");
  eq(h.parsePageRanges("", 10), [], "nothing asked, nothing given");
  eq(h.describePages([1, 2, 3, 7, 9, 10]), "1-3, 7, 9-10", "and back again");
  eq(h.foldForSearch("كتاب ي"), h.foldForSearch("کتاب ی"), "Arabic and Persian letters are one for searching");
  eq(h.foldForSearch("۱۲۳"), "123", "so are Persian digits and plain ones");
}

// ── a document ────────────────────────────────────────────────────────────
const docOf = (pages, { scanned = [] } = {}) => ({
  numPages: pages.length,
  getMetadata: async () => ({ info: { Title: "Annual report" } }),
  getPage: async (n) => ({
    getTextContent: async () => ({ items: scanned.includes(n) ? [] : pages[n - 1].split(" ").map((w) => ({ str: w })) }),
    getViewport: () => ({ width: 100, height: 100 }),
    render: () => ({ promise: Promise.resolve() }),
  }),
  destroy() { destroyed++; },
});
let destroyed = 0;
const lorem = (n, tag) => Array.from({ length: 400 }, (_, i) => `${tag}${n}word${i}`).join(" ");
const sample = (n) => Array.from({ length: n }, (_, i) => (i === 6 ? `Revenue figures for the northern region ${lorem(i + 1, "p")}` : lorem(i + 1, "p")));

const makeEnv = (doc, extra = {}) => {
  const library = new h.PdfLibrary(async () => ({ getDocument: () => ({ promise: Promise.resolve(doc) }) }), async (_d, n) => ({ data: `IMG${n}`, mimeType: "image/jpeg" }));
  return { library, readVault: async (p) => (p === "Papers/r.pdf" ? { bytes: new Uint8Array([1, 2, 3]), key: "r:1" } : null), vision: false, ...extra };
};

{
  // A short one comes back whole.
  const short = docOf(["Alpha beta gamma delta.", "Second page text here."]);
  const env = makeEnv(short);
  env.library.addAttachment("Short.pdf", new Uint8Array([1]));
  let out = await h.readPdfTool({}, env);
  ok(out.includes("Short.pdf: 2 pages") && out.includes("[Page 1]") && out.includes("Second page text here."), "a short PDF is returned whole");
  // A long one gets an overview.
  const long = docOf(sample(12));
  const env2 = makeEnv(long);
  env2.library.addAttachment("Long.pdf", new Uint8Array([1]));
  out = await h.readPdfTool({}, env2);
  ok(/Long\.pdf: 12 pages, titled "Annual report"; 12 with text/.test(out), "a long one starts with how big it is and what it is called");
  ok(/^1: p1word0/m.test(out) && /^12: p12word0/m.test(out), "and the first words of every page");
  ok(/read_pdf with pages/.test(out) && /query/.test(out), "and how to read on");
  // Pages.
  out = await h.readPdfTool({ pages: "2-3" }, env2);
  ok(out.includes("[Page 2]") && out.includes("[Page 3]") && !out.includes("[Page 4]"), "pages by number");
  const capped = makeEnv(docOf(sample(12)), { maxChars: 1_500 });
  capped.library.addAttachment("Long.pdf", new Uint8Array([1]));
  out = await h.readPdfTool({ pages: "1-12" }, capped);
  ok(/Stopped after page \d+: that is as much as one call returns\. Continue with pages "\d+-12"/.test(out), "a call returns what fits and says where to go on");
  // Search.
  out = await h.readPdfTool({ query: "northern region" }, env2);
  ok(/Page 7: .*Revenue figures for the northern region/.test(out) && !/Page 6:/.test(out), "a search says which pages and shows where");
  out = await h.readPdfTool({ query: "nonexistent phrase" }, env2);
  ok(/does not appear in the text of Long\.pdf \(12 pages\)/.test(out), "and says when nothing was found");
  // Which document.
  env2.library.addAttachment("Other.pdf", new Uint8Array([2]));
  out = await h.readPdfTool({}, env2);
  ok(/Several PDFs are attached \(Long\.pdf, Other\.pdf\)/.test(out), "with two attached the model has to say which");
  out = await h.readPdfTool({ attachment: "oth", pages: "1" }, env2);
  ok(out.includes("[Page 1]"), "a part of the name is enough");
  out = await h.readPdfTool({ attachment: "missing.pdf" }, env2);
  ok(/No attached PDF is called "missing\.pdf"/.test(out), "a name that is not there is said");
  out = await h.readPdfTool({ path: "Papers/r.pdf", pages: "1" }, env2);
  ok(out.includes("[Page 1]"), "a PDF in the vault is read by its path");
  out = await h.readPdfTool({ path: "Papers/none.pdf" }, env2);
  ok(/PDF not found: Papers\/none\.pdf\. Use find_pdfs/.test(out), "and one that is not there is said");
  out = await h.readPdfTool({}, makeEnv(short));
  ok(/No PDF has been attached/.test(out), "with nothing attached and no path, the model is told where to look");
}

// ── pages without text ────────────────────────────────────────────────────
{
  const pages = ["Text page one is fine.", "", "Text page three is fine."];
  const mk = (extra) => {
    const e = makeEnv(docOf(pages, { scanned: [2] }), extra);
    e.library.addAttachment("Mixed.pdf", new Uint8Array([1]));
    return e;
  };
  let out = await h.readPdfTool({ pages: "1-3" }, mk({ vision: true }));
  ok(out.includes("[Page 1]") && out.includes("[Page 3]") && out.includes('"dataUri":"data:image/jpeg;base64,IMG2"') && out.includes("Mixed.pdf page 2"), "a scan page is handed over as a picture to a model that can see");
  out = await h.readPdfTool({ pages: "1-3" }, mk({ vision: false, describe: async (images, name) => `page ${images[0].page} of ${name}: an invoice` }));
  ok(out.includes("an invoice") && out.includes("read by a vision model"), "…or read by another model for one that cannot");
  out = await h.readPdfTool({ pages: "1-3" }, mk({ vision: false }));
  ok(/cannot see images; no vision model is available/.test(out), "…or the model is told plainly that nobody can read it");
  out = await h.readPdfTool({ pages: "1", view: true }, mk({ vision: true }));
  ok(out.includes('"dataUri":"data:image/jpeg;base64,IMG1"'), "a page of text can be asked for as a picture (a figure, a table)");
  out = await h.readPdfTool({}, mk({ vision: true }));
  ok(!/\(no text layer\)/.test(out) || out.includes("Mixed.pdf"), "the overview of a short PDF is its text");
}

// ── the tool inside the registry ──────────────────────────────────────────
{
  const files = new Map([["Papers/r.pdf", new Uint8Array([1, 2, 3])], ["Other/x.pdf", new Uint8Array([4])], ["n.md", null]]);
  const file = (p) => (files.has(p) ? Object.assign(new (Object.getPrototypeOf(class {}).constructor)(), { path: p, extension: p.split(".").pop(), stat: { mtime: 1, size: 3 } }) : null);
  const app = { vault: { getFileByPath: (p) => file(p), readBinary: async (f) => files.get(f.path).buffer, getRoot: () => ({ children: [] }), getFolderByPath: () => null } };
  const registry = new h.ToolRegistry(app);
  registry.pdf.setLoader(async () => ({ getDocument: () => ({ promise: Promise.resolve(docOf(["Alpha text of the vault PDF page one."])) }) }));
  const names = registry.getDefinitions().map((d) => d.name);
  ok(names.includes("read_pdf") && names.includes("find_pdfs"), "both tools are offered");
  const def = registry.getDefinitions().find((d) => d.name === "read_pdf");
  ok(/attached to this chat/.test(def.description) && Object.keys(def.parameters.properties).join() === "path,attachment,pages,query,view", "…described with what they take");

  // Scope: a note-only context cannot read another vault PDF; an attached PDF is not in the vault.
  registry.setAccessScope({ mode: "note", notePath: "n.md", folderPath: "" });
  let result = await registry.execute({ id: "1", name: "read_pdf", arguments: JSON.stringify({ path: "Papers/r.pdf" }) });
  ok(/Access denied/.test(result.output), "a vault PDF outside the scope is refused");
  ok(registry.getAccessRequest({ id: "1", name: "read_pdf", arguments: JSON.stringify({ path: "Papers/r.pdf" }) })?.requestedMode === "note", "…and can be asked for");
  registry.pdf.addAttachment("Attached.pdf", new Uint8Array([9]));
  result = await registry.execute({ id: "2", name: "read_pdf", arguments: JSON.stringify({}) });
  ok(result.output.includes("Alpha text"), "an attached PDF needs no access to the vault");
  registry.setAccessScope({ mode: "vault" });
  result = await registry.execute({ id: "3", name: "read_pdf", arguments: JSON.stringify({ path: "Papers/r.pdf" }) });
  ok(result.output.includes("Alpha text"), "with the vault open a path is read");
  result = await registry.execute({ id: "4", name: "read_pdf", arguments: JSON.stringify({ path: "n.md" }) });
  ok(/PDF not found/.test(result.output), "a note is not a PDF");
}

console.log(`HARNESS_PDF_OK (${count()} checks)`);
