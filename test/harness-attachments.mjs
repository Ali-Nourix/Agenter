// What reaches the model when something is attached: pictures, PDFs, Office files, text, audio; for a model that
// can see, one that cannot, one that reads PDFs, one that does not.
import { deflateRawSync } from "zlib";
import { load, eq, ok, count } from "./harness-helpers.mjs";

const h = await load("test/harness-entry.ts");

// ── a minimal zip writer, for Office files ────────────────────────────────
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  let entries = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
    entries++;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries, 8); eocd.writeUInt16LE(entries, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}
const b64 = (buf) => Buffer.from(buf).toString("base64");

// ── file types ────────────────────────────────────────────────────────────
eq(h.classifyAttachment("a.PNG", ""), "image", "png by name");
eq(h.classifyAttachment("x", "image/webp"), "image", "image by type");
eq(h.classifyAttachment("r.pdf", ""), "pdf", "pdf");
eq(h.classifyAttachment("notes.md", ""), "text", "markdown");
eq(h.classifyAttachment("data.csv", "text/csv"), "text", "csv");
eq(h.classifyAttachment("a.docx", ""), "docx", "docx");
eq(h.classifyAttachment("a.xlsx", ""), "xlsx", "xlsx");
eq(h.classifyAttachment("a.pptx", ""), "pptx", "pptx");
eq(h.classifyAttachment("voice.m4a", ""), "audio", "audio");
eq(h.classifyAttachment("tool.exe", "application/octet-stream"), "unsupported", "unknown");

// ── image headers ─────────────────────────────────────────────────────────
{
  const png = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  eq(h.imageSize(new Uint8Array(png)), { width: 640, height: 480 }, "PNG size");
  const gif = Buffer.from("GIF89a", "latin1"); const g = Buffer.concat([gif, Buffer.from([0x20, 0x01, 0x10, 0x01, 0, 0])]);
  eq(h.imageSize(new Uint8Array(g)), { width: 288, height: 272 }, "GIF size");
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03, 0x01, 0x11, 0x00]);
  const js = h.imageSize(new Uint8Array(jpg));
  eq([js.width, js.height], [512, 256], "JPEG size");
  eq(h.imageSize(new Uint8Array([1, 2, 3])), null, "not an image");
}

// ── Office files ──────────────────────────────────────────────────────────
const docx = zip({ "word/document.xml": '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world &amp; co</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r><w:r><w:tab/><w:t>tabbed</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' });
eq(h.extractDocx(new Uint8Array(docx)).split("\n").filter(Boolean).slice(0, 2), ["Hello world & co", "Second\ttabbed"], "docx paragraphs, entities and tabs");
ok(h.extractDocx(new Uint8Array(docx)).includes("A1") && h.extractDocx(new Uint8Array(docx)).includes("B1"), "docx tables");
const pptx = zip({
  "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>",
  "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Title</a:t></a:r></a:p><a:p><a:r><a:t>Bullet</a:t></a:r></a:p></p:sld>",
  "ppt/notesSlides/notesSlide1.xml": "<p:notes><a:p><a:r><a:t>say hi</a:t></a:r></a:p></p:notes>",
});
const slides = h.extractPptx(new Uint8Array(pptx));
ok(slides.indexOf("Slide 1") < slides.indexOf("Slide 2") && slides.includes("Title\nBullet") && slides.includes("[Notes: say hi]"), "pptx slides in order, with notes");
const xlsx = zip({
  "xl/workbook.xml": '<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
  "xl/sharedStrings.xml": "<sst><si><t>Item</t></si><si><t>Cost</t></si><si><t>Coffee</t></si></sst>",
  "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>4.5</v></c></row></sheetData></worksheet>',
});
eq(h.extractXlsx(new Uint8Array(xlsx)), "--- Sheet: Budget ---\nItem\tCost\nCoffee\t\t4.5", "xlsx: shared strings, numbers, empty cells");
let threw = false;
try { h.readZip(new Uint8Array([1, 2, 3, 4])); } catch { threw = true; }
eq(threw, true, "a file that is not a zip is refused");

// ── preparing a turn ──────────────────────────────────────────────────────
const log = new h.HarnessLog();
const sink = [];
const base = (over = {}) => ({
  text: "Please summarize.",
  parts: [],
  profile: h.resolveModelProfile({ providerId: "p", providerType: "openai-compatible", baseUrl: "https://x/v1", model: "plain-model", supportsVision: false }),
  app: {}, settings: {}, log,
  notice: (t) => sink.push(t),
  describe: async () => null,
  signal: new AbortController().signal,
  contextBudget: 20_000,
  env: { downscale: async () => null, renderPage: async (_d, n) => ({ data: `PAGE${n}`, mimeType: "image/jpeg" }) },
  ...over,
});
const vision = h.resolveModelProfile({ providerId: "p", providerType: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", supportsVision: true });
const visionNoPdf = h.resolveModelProfile({ providerId: "p", providerType: "openai-compatible", baseUrl: "https://x/v1", model: "llava", supportsVision: true });
const claude = h.resolveModelProfile({ providerId: "p", providerType: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5", supportsVision: true });
const png = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(800, 16); png.writeUInt32BE(600, 20);
const imagePart = { type: "image", data: b64(png), mimeType: "image/png", name: "chart.png" };

{
  // A model that can see gets the picture.
  let r = await h.prepareUserTurn(base({ profile: vision, parts: [imagePart] }));
  eq([r.parts.length, r.parts[0].type, r.parts[0].name], [1, "image", "chart.png"], "an image reaches a model that can see");
  ok(r.content.includes("chart.png (800×600)") && r.content.endsWith("Please summarize."), "and the text says what it is, with the request last");
  // One that cannot, with a helper: gets a description.
  const asked = [];
  r = await h.prepareUserTurn(base({ parts: [imagePart], describe: async (messages) => { asked.push(messages); return "A bar chart of sales by month. Text: Q1 12, Q2 15."; } }));
  eq(r.parts.length, 0, "no image goes to a model that cannot see");
  ok(r.content.includes("A bar chart of sales by month") && r.content.includes("described by a vision model"), "its description does");
  eq([asked[0][1].parts[0].type, asked[0][0].content.startsWith("You describe images")], ["image", true], "the helper was shown the picture and told how to describe it");
  ok(sink.some((t) => /Describing chart\.png/.test(t)), "the person was told");
  // With no helper: the model still learns it is there.
  r = await h.prepareUserTurn(base({ parts: [imagePart] }));
  ok(/cannot see images and no vision model is available/.test(r.content) && r.content.includes("chart.png") && r.content.includes("800×600"), "with nobody to look, the model is told what was attached and that it cannot see it");
  ok(/do not guess/.test(r.content), "and not to make it up");
  eq(r.notes[0].includes("could not be shown"), true, "the note says so");
}

{
  // PDFs: native where the provider reads them.
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Pages /Count 3 >> endobj\n%%EOF");
  const part = { type: "pdf", data: b64(pdf), mimeType: "application/pdf", name: "report.pdf" };
  let r = await h.prepareUserTurn(base({ profile: claude, parts: [part] }));
  eq([r.parts.length, r.parts[0].type, r.parts[0].metadata.pages], [1, "pdf", 3], "a PDF goes whole to a provider that reads PDFs");
  eq(h.estimateMessageTokens({ role: "user", content: "", parts: r.parts }) > 5000, true, "and is counted as the pages it costs");

  // Otherwise its text is read, page by page.
  const doc = (pages) => ({ numPages: pages.length, getPage: async (n) => ({ getTextContent: async () => ({ items: pages[n - 1].split(" ").map((s) => ({ str: s })) }), getViewport: () => ({ width: 100, height: 100 }), render: () => ({ promise: Promise.resolve() }) }), destroy() {} });
  const long = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt";
  const withText = { loadPdfJs: async () => ({ getDocument: () => ({ promise: Promise.resolve(doc([long, long + " two", long + " three"])) }) }), downscale: async () => null, renderPage: async (_d, n) => ({ data: `PAGE${n}`, mimeType: "image/jpeg" }) };
  r = await h.prepareUserTurn(base({ parts: [part], env: withText }));
  ok(r.content.includes("[Page 1]") && r.content.includes("[Page 3]") && r.content.includes("Lorem ipsum"), "text is read out of every page");
  eq(r.parts.length, 0, "and nothing else is sent");
  // Scanned: no text layer.
  const scanned = { ...withText, loadPdfJs: async () => ({ getDocument: () => ({ promise: Promise.resolve(doc(["", "", ""])) }) }) };
  r = await h.prepareUserTurn(base({ profile: visionNoPdf, parts: [part], env: scanned }));
  eq([r.parts.map((p) => p.type), r.parts.map((p) => p.name)], [["image", "image", "image"], ["report.pdf page 1", "report.pdf page 2", "report.pdf page 3"]], "a scanned PDF is drawn and shown to a model that can see");
  r = await h.prepareUserTurn(base({ parts: [part], env: scanned, describe: async (messages) => `[Page 1] transcribed ${messages[1].parts.length} pages` }));
  ok(r.content.includes("transcribed 3 pages") && r.parts.length === 0, "…or read by the helper for one that cannot");
  r = await h.prepareUserTurn(base({ parts: [part], env: scanned }));
  ok(/scanned \(no text layer\).*cannot see images/.test(r.content), "…or the model is told honestly that it cannot be read");
  // A budget.
  const big = "word ".repeat(40_000);
  const huge = { ...withText, loadPdfJs: async () => ({ getDocument: () => ({ promise: Promise.resolve(doc([big, big, big, big])) }) }) };
  r = await h.prepareUserTurn(base({ parts: [part], env: huge, contextBudget: 3_000 }));
  ok(r.content.length < 14_000, "text from a long PDF is held to a share of the window");
  ok(/omitted|\[…\]/.test(r.content), "and says it was cut");
}

{
  // Text and Office files.
  let r = await h.prepareUserTurn(base({ parts: [{ type: "file", data: b64("a,b\n1,2\n"), name: "t.csv", mimeType: "text/csv" }] }));
  ok(r.content.includes('<attachment name="t.csv">') && r.content.includes("a,b\n1,2"), "a CSV is read as text");
  r = await h.prepareUserTurn(base({ parts: [{ type: "file", data: b64(docx), name: "w.docx" }, { type: "file", data: b64(xlsx), name: "s.xlsx" }, { type: "file", data: b64(pptx), name: "p.pptx" }] }));
  ok(r.content.includes("Hello world & co") && r.content.includes("Coffee\t\t4.5") && r.content.includes("--- Slide 1 ---"), "docx, xlsx and pptx are read together");
  eq(r.parts.length, 0, "none of them is sent as a part");
  r = await h.prepareUserTurn(base({ parts: [{ type: "file", data: b64("MZ"), name: "x.exe", mimeType: "application/octet-stream" }] }));
  ok(/kind of file Agenter cannot read/.test(r.content), "an unknown kind is named, not ignored");
  r = await h.prepareUserTurn(base({ parts: [{ type: "file", data: b64("not a zip"), name: "broken.docx" }] }));
  ok(/could not be read/.test(r.content) && r.notes[0].includes("failed"), "a broken file is a note, not a crash");
  r = await h.prepareUserTurn(base({ parts: [{ type: "file", data: "", name: "empty.txt" }] }));
  ok(/is empty/.test(r.content), "an empty file is said to be empty");
  // Several share the budget.
  const many = ["a", "b", "c"].map((n) => ({ type: "file", data: b64("x".repeat(60_000)), name: `${n}.txt` }));
  r = await h.prepareUserTurn(base({ parts: many, contextBudget: 4_000 }));
  ok(r.content.length < 20_000, "several files together stay inside the share");
  eq((r.content.match(/<attachment name=/g) ?? []).length, 3, "…and each is there");
}

{
  // Audio.
  const gemini = h.resolveModelProfile({ providerId: "g", providerType: "gemini", baseUrl: "https://g", model: "gemini-2.5-flash", supportsVision: true });
  const audio = { type: "audio", data: b64("RIFFxxxx"), mimeType: "audio/wav", name: "memo.wav" };
  let r = await h.prepareUserTurn(base({ profile: gemini, parts: [audio] }));
  eq([r.parts.length, r.parts[0].type], [1, "audio"], "audio goes to a model that listens");
  r = await h.prepareUserTurn(base({ parts: [audio], describe: async () => "Hello, this is a reminder." }));
  ok(r.content.includes("Hello, this is a reminder.") && r.parts.length === 0, "…and is transcribed for one that does not");
  r = await h.prepareUserTurn(base({ parts: [audio] }));
  ok(/cannot listen/.test(r.content), "…and with nobody to transcribe, the model is told");
}

{
  // What the chips promise.
  const p = (profile, kind, helper) => h.planFor(kind, profile, helper).plan;
  eq([p(vision, "image", false), p(base().profile, "image", true), p(base().profile, "image", false)], ["native", "described", "listed"], "images");
  eq([p(claude, "pdf", false), p(base().profile, "pdf", false), p(base().profile, "docx", false), p(base().profile, "unsupported", false)], ["native", "text", "text", "unsupported"], "documents");
  eq(h.countPdfPages(new Uint8Array(Buffer.from("/Type /Page\n/Type /Page\n/Type /Pages"))), 2, "pages counted without /Count");
}

console.log(`HARNESS_ATTACHMENTS_OK (${count()} checks)`);
