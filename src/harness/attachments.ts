// ── harness/attachments.ts ────────────────────────────────────────────────
// Whatever a person attaches should reach the model in the best form it can
// use, and where it cannot use it at all the model should at least know the
// attachment is there and what it is.
//
//   images       a model that can see gets the picture (shrunk if it is huge);
//                one that cannot gets a description written by a model that
//                can (the "vision helper"), or, with none to ask, a note that
//                says a picture of this size and name was attached and that
//                it cannot be seen, so the answer is honest rather than made up.
//   PDFs         sent as they are to providers that read PDFs; otherwise the
//                text is read out page by page with Obsidian's own pdf.js; a
//                scanned PDF (no text) is drawn page by page and shown to a
//                model that can see, or described by the helper.
//   Word, Excel, PowerPoint, text, code, CSV, JSON, HTML …
//                read as text (the Office formats are zip files of XML, which
//                needs nothing but a small unzipper).
//   audio        sent to providers that listen (Gemini); otherwise a note.
//
// Everything that becomes text is held to a share of the window, with a note
// where it was cut.
// ─────────────────────────────────────────────────────────────────────────────

import { inflateRawSync } from "zlib";
import type { App } from "obsidian";
import type { AgentSettings } from "../settings";
import type { ChatMessage } from "../api";
import type { MessagePart } from "../provider-types";
import type { HarnessLog } from "./diagnostics";
import type { ModelProfile } from "./model-profile";
import { truncateMiddle } from "./tool-output";

export type AttachmentKind = "image" | "pdf" | "audio" | "text" | "docx" | "pptx" | "xlsx" | "unsupported";

export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
/** Pages of a PDF read as text, or drawn, for one message. */
const MAX_PDF_PAGES_AS_TEXT = 400;
const MAX_RENDERED_PAGES = 8;
const MAX_DESCRIBED_IMAGES = 8;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "html", "htm", "css", "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "ps1", "sql", "toml", "ini", "cfg", "conf", "log", "tex", "rst", "org", "srt", "vtt", "svg", "env", "gitignore", "lua", "swift", "r", "scala", "dart",
]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const AUDIO_EXTENSIONS = new Set(["wav", "mp3", "m4a", "ogg", "webm", "flac", "aac", "opus"]);

/** The file types the picker offers. */
export const ATTACHMENT_ACCEPT =
  "image/*,audio/*,application/pdf,.pdf,.docx,.pptx,.xlsx,.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.htm,.log,.js,.ts,.py,.sql,.css,.tex,.srt,.vtt,.wav,.mp3,.m4a,.ogg,.webm,.flac";

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name ?? "");
  return m ? m[1].toLowerCase() : "";
}

export function classifyAttachment(name: string, mime: string): AttachmentKind {
  const ext = extensionOf(name);
  const type = (mime ?? "").toLowerCase();
  if (type.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) return "image";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type.startsWith("audio/") || AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (ext === "docx" || type.includes("wordprocessingml")) return "docx";
  if (ext === "pptx" || type.includes("presentationml")) return "pptx";
  if (ext === "xlsx" || type.includes("spreadsheetml")) return "xlsx";
  if (type.startsWith("text/") || type === "application/json" || type === "application/xml" || TEXT_EXTENSIONS.has(ext)) return "text";
  return "unsupported";
}

export function mimeFor(name: string, given: string): string {
  if (given) return given;
  switch (extensionOf(name)) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "pdf": return "application/pdf";
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "m4a": return "audio/mp4";
    case "ogg": return "audio/ogg";
    case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default: return "text/plain";
  }
}

/** How the model will receive an attachment: what the chip can promise before sending. */
export type AttachmentPlan = "native" | "text" | "described" | "listed" | "unsupported";

export function planFor(kind: AttachmentKind, profile: Pick<ModelProfile, "vision" | "pdfNative" | "providerType">, helperAvailable: boolean): { plan: AttachmentPlan; label: string } {
  switch (kind) {
    case "image":
      if (profile.vision) return { plan: "native", label: "The model will see this image." };
      return helperAvailable
        ? { plan: "described", label: "This model cannot see images: another model will describe it first." }
        : { plan: "listed", label: "This model cannot see images and none is set up to describe it: the model will only be told it was attached." };
    case "pdf":
      return profile.pdfNative
        ? { plan: "native", label: "The PDF is sent as it is; the provider reads its pages." }
        : { plan: "text", label: profile.vision ? "The text is read out of the PDF; scanned pages are shown to the model." : helperAvailable ? "The text is read out of the PDF; scanned pages are described by another model." : "The text is read out of the PDF (scanned pages cannot be read)." };
    case "audio":
      return profile.providerType === "gemini"
        ? { plan: "native", label: "The model will listen to this audio." }
        : helperAvailable
          ? { plan: "described", label: "Another model will transcribe it first." }
          : { plan: "listed", label: "This model cannot listen: it will only be told the audio was attached." };
    case "docx": case "pptx": case "xlsx": case "text":
      return { plan: "text", label: "Its text is read and given to the model." };
    default:
      return { plan: "unsupported", label: "This kind of file cannot be read." };
  }
}

// ── binary helpers ────────────────────────────────────────────────────────

export function base64ToBytes(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

export function decodeText(bytes: Uint8Array): string {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/** Width and height of a PNG, JPEG, GIF or WebP, from its header, without decoding it. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return null;
  }
  if (b.length > 30 && String.fromCharCode(b[0], b[1], b[2], b[3]) === "RIFF" && String.fromCharCode(b[8], b[9], b[10], b[11]) === "WEBP") {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === "VP8 ") return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
    if (kind === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

// ── a small unzipper, enough for Office files ─────────────────────────────

export function readZip(bytes: Uint8Array): Map<string, () => Uint8Array> {
  const out = new Map<string, () => Uint8Array>();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("This is not a zip file.");
  const entries = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  for (let n = 0; n < entries; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compressed = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out.set(name, () => {
      const localName = dv.getUint16(local + 26, true);
      const localExtra = dv.getUint16(local + 28, true);
      const start = local + 30 + localName + localExtra;
      const raw = bytes.subarray(start, start + compressed);
      if (method === 0) return raw;
      if (method === 8) return new Uint8Array(inflateRawSync(raw));
      throw new Error(`Unsupported zip compression (${method}).`);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function xmlText(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

function readEntry(zip: Map<string, () => Uint8Array>, name: string): string | null {
  const entry = zip.get(name);
  return entry ? decodeText(entry()) : null;
}

export function extractDocx(bytes: Uint8Array): string {
  const zip = readZip(bytes);
  const xml = readEntry(zip, "word/document.xml");
  if (!xml) throw new Error("This Word file has no document body.");
  const text = xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, "")
    .replace(/<[^>]+>/g, "");
  return xmlText(text).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function extractPptx(bytes: Uint8Array): string {
  const zip = readZip(bytes);
  const slides = [...zip.keys()]
    .map((name) => ({ name, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1] ?? NaN) }))
    .filter((s) => Number.isFinite(s.n))
    .sort((a, b) => a.n - b.n);
  const parts: string[] = [];
  for (const slide of slides) {
    const xml = readEntry(zip, slide.name) ?? "";
    const text = xmlText(xml.replace(/<\/a:p>/g, "\n").replace(/<[^>]+>/g, "")).replace(/\n{2,}/g, "\n").trim();
    const notesXml = readEntry(zip, `ppt/notesSlides/notesSlide${slide.n}.xml`);
    const notes = notesXml ? xmlText(notesXml.replace(/<\/a:p>/g, "\n").replace(/<[^>]+>/g, "")).replace(/\n{2,}/g, "\n").trim() : "";
    parts.push(`--- Slide ${slide.n} ---\n${text}${notes ? `\n[Notes: ${notes}]` : ""}`);
  }
  return parts.join("\n\n");
}

export function extractXlsx(bytes: Uint8Array, maxRows = 400): string {
  const zip = readZip(bytes);
  const shared: string[] = [];
  const sst = readEntry(zip, "xl/sharedStrings.xml");
  if (sst) {
    for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(xmlText([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
    }
  }
  const names: string[] = [];
  const workbook = readEntry(zip, "xl/workbook.xml");
  if (workbook) for (const m of workbook.matchAll(/<sheet [^>]*name="([^"]*)"/g)) names.push(xmlText(m[1]));
  const sheets = [...zip.keys()]
    .map((name) => ({ name, n: Number(/^xl\/worksheets\/sheet(\d+)\.xml$/.exec(name)?.[1] ?? NaN) }))
    .filter((s) => Number.isFinite(s.n))
    .sort((a, b) => a.n - b.n);
  const out: string[] = [];
  sheets.forEach((sheet, index) => {
    const xml = readEntry(zip, sheet.name) ?? "";
    const rows: string[] = [];
    let omitted = 0;
    for (const row of xml.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= maxRows) { omitted++; continue; }
      const cells: string[] = [];
      for (const cell of row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1];
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "";
        const col = ref.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        const type = /t="([^"]*)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(cell[2] ?? "")?.[1];
        const inline = /<t[^>]*>([\s\S]*?)<\/t>/.exec(cell[2] ?? "")?.[1];
        let value = "";
        if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
        else if (type === "inlineStr" && inline !== undefined) value = xmlText(inline);
        else if (v !== undefined) value = xmlText(v);
        if (col >= 0) { while (cells.length < col) cells.push(""); cells[col] = value; }
        else cells.push(value);
      }
      if (cells.some((c) => c !== "")) rows.push(cells.join("\t"));
    }
    out.push(`--- Sheet: ${names[index] ?? `Sheet${sheet.n}`} ---\n${rows.join("\n")}${omitted ? `\n[${omitted} more rows not shown]` : ""}`);
  });
  return out.join("\n\n");
}

// ── PDFs ──────────────────────────────────────────────────────────────────

/** The part of pdf.js that is used. Obsidian provides it through `loadPdfJs()`. */
export interface PdfJsLike {
  getDocument(src: { data: Uint8Array } | Uint8Array): { promise: Promise<PdfDocLike> };
}
export interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
  destroy?: () => void;
}
export interface PdfPageLike {
  getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: { canvasContext: unknown; viewport: unknown }): { promise: Promise<void> };
}

export interface PdfText {
  pages: number;
  /** Pages that had a text layer. */
  textPages: number;
  text: string;
  truncated: boolean;
}

/** The text of a PDF, page by page, up to `maxChars`. */
export async function pdfToText(doc: PdfDocLike, maxChars: number, shouldStop?: () => boolean): Promise<PdfText> {
  const pages = doc.numPages;
  const out: string[] = [];
  let total = 0;
  let textPages = 0;
  let truncated = false;
  for (let n = 1; n <= Math.min(pages, MAX_PDF_PAGES_AS_TEXT); n++) {
    if (shouldStop?.()) break;
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      text += item.str ?? "";
      text += item.hasEOL ? "\n" : " ";
    }
    text = text.replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length >= 40) textPages++;
    const block = `[Page ${n}]\n${text}`;
    if (total + block.length > maxChars) {
      out.push(block.slice(0, Math.max(0, maxChars - total)) + "\n[…]");
      truncated = true;
      break;
    }
    out.push(block);
    total += block.length + 2;
  }
  if (!truncated && pages > MAX_PDF_PAGES_AS_TEXT) truncated = true;
  return { pages, textPages, text: out.join("\n\n"), truncated };
}

/** Rough page count of a PDF from its bytes, for providers that read it natively. */
export function countPdfPages(bytes: Uint8Array): number {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 4_000_000))).toString("latin1");
  const counts = [...head.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  if (counts.length) return Math.max(...counts);
  return (head.match(/\/Type\s*\/Page[^s]/g) ?? []).length || 1;
}

// ── the environment: what needs the renderer ──────────────────────────────

/** A page of a PDF drawn as a JPEG, base64 without the prefix. Needs a DOM. */
export async function renderPdfPage(doc: PdfDocLike, n: number, maxSide = 1600): Promise<{ data: string; mimeType: string } | null> {
  if (typeof document === "undefined") return null;
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, maxSide / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return { data: canvas.toDataURL("image/jpeg", 0.85).split(",")[1] ?? "", mimeType: "image/jpeg" };
}

/** Shrinks a large picture: providers refuse some sizes, and a huge one is slow and no better understood. */
export async function downscaleImage(data: string, mime: string, maxSide = 2000): Promise<{ data: string; mimeType: string } | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  try {
    const img = new Image();
    img.src = `data:${mime};base64,${data}`;
    await img.decode();
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    if (longest <= maxSide && data.length < 3_500_000) return null;
    const scale = Math.min(1, maxSide / longest);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { data: canvas.toDataURL("image/jpeg", 0.88).split(",")[1] ?? "", mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}

export interface AttachmentEnv {
  loadPdfJs?: () => Promise<PdfJsLike>;
  downscale?: typeof downscaleImage;
  renderPage?: typeof renderPdfPage;
}

// ── preparing a turn ──────────────────────────────────────────────────────

export interface PreparedTurn {
  /** The text of the message: what was typed, with what was read out of the attachments in front of it. */
  content: string;
  /** What goes to the provider as it is (pictures, PDFs, audio). */
  parts: MessagePart[];
  /** One line per attachment on how it was handled. */
  notes: string[];
}

export interface PrepareArgs {
  text: string;
  parts: MessagePart[];
  profile: ModelProfile;
  app: App;
  settings: AgentSettings;
  log: HarnessLog;
  notice: (text: string) => void;
  /** Asks a model that can see (or listen) to describe what is in the messages. Null if there is none. */
  describe: (messages: ChatMessage[], signal: AbortSignal) => Promise<string | null>;
  signal: AbortSignal;
  /** Tokens the text of all the attachments together may take. */
  contextBudget: number;
  env?: AttachmentEnv;
}

const DESCRIBE_SYSTEM =
  "You describe images for someone who cannot see them. Be exact and complete. First transcribe all visible text verbatim, in its own language and in reading order. Then describe what is shown: objects, people, layout, colours; for charts and tables give the labels and the numbers; for screenshots say what application and what state. No preamble and no opinions.";
const TRANSCRIBE_SYSTEM =
  "You transcribe audio faithfully, in the language spoken, with speaker changes marked where you can tell. Add a one-line description of non-speech sounds only if they matter. No preamble.";

function sizeLabel(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Works out, for each attachment, what this model can be given, and builds
 * the message. Never throws for one bad attachment: it becomes a note.
 */
export async function prepareUserTurn(args: PrepareArgs): Promise<PreparedTurn> {
  const { profile, log, notice, signal } = args;
  const env = args.env ?? {};
  const loadPdf = env.loadPdfJs ?? (async () => {
    const { loadPdfJs } = await import("obsidian");
    return (await loadPdfJs()) as PdfJsLike;
  });
  const outParts: MessagePart[] = [];
  const blocks: string[] = [];
  const notes: string[] = [];
  const textBudgetChars = Math.max(4_000, args.contextBudget * 3);
  let remaining = textBudgetChars;
  let describedCount = 0;
  const remainingFiles = () => Math.max(1, args.parts.length);

  const addText = (title: string, body: string, hint = "Ask the user which part they need") => {
    const share = Math.max(2_000, Math.floor(remaining / Math.max(1, pending)));
    const cut = truncateMiddle(body, share, hint);
    remaining = Math.max(0, remaining - cut.text.length);
    blocks.push(`<attachment name="${title}">\n${cut.text}\n</attachment>`);
    return cut.truncated;
  };

  let pending = remainingFiles();
  for (const part of args.parts) {
    pending = Math.max(1, pending);
    const name = part.name ?? "attachment";
    const mime = mimeFor(name, part.mimeType ?? "");
    const kind = classifyAttachment(name, mime);
    const bytes = part.data ? base64ToBytes(part.data) : new Uint8Array(0);
    const note = (line: string) => { notes.push(`${name}: ${line}`); log.add("attachment", `${name}: ${line}`); };
    try {
      if (!bytes.length && kind !== "unsupported") {
        blocks.push(`[The attachment "${name}" is empty.]`);
        note("empty");
        continue;
      }

      if (kind === "image") {
        const size = imageSize(bytes);
        const dims = size ? `${size.width}×${size.height}` : "size unknown";
        if (profile.vision) {
          let data = part.data!;
          let type = mime;
          const shrunk = await (env.downscale ?? downscaleImage)(data, type);
          if (shrunk) { data = shrunk.data; type = shrunk.mimeType; note(`shrunk to fit (${dims} → JPEG)`); }
          outParts.push({ type: "image", data, mimeType: type, name });
          blocks.push(`[Attached image: ${name} (${dims}), shown to you.]`);
          note("sent as an image");
        } else if (describedCount < MAX_DESCRIBED_IMAGES) {
          notice(`Describing ${name} for a model that cannot see…`);
          describedCount++;
          const description = await args.describe(
            [
              { role: "system", content: DESCRIBE_SYSTEM },
              { role: "user", content: `Describe this image (${name}).`, parts: [{ type: "image", data: part.data, mimeType: mime, name }] },
            ],
            signal
          );
          if (description) {
            addText(`${name} (image, described by a vision model, ${dims})`, description);
            note("described by a vision model");
          } else {
            blocks.push(`[The user attached an image: "${name}" (${dims}, ${sizeLabel(bytes.length)}). This model cannot see images and no vision model is available to describe it. Say so plainly and ask the user to describe it or to switch to a model that can see images; do not guess what it shows.]`);
            note("could not be shown or described");
          }
        } else {
          blocks.push(`[The user attached an image "${name}" that could not be described (too many images).]`);
        }
      } else if (kind === "pdf") {
        const pages = countPdfPages(bytes);
        if (profile.pdfNative && bytes.length <= 30 * 1024 * 1024 && pages <= 100) {
          outParts.push({ type: "pdf", data: part.data, mimeType: "application/pdf", name, metadata: { pages } });
          blocks.push(`[Attached PDF: ${name} (${pages} pages), given to you whole.]`);
          note(`sent as a PDF (${pages} pages)`);
        } else {
          notice(`Reading ${name}…`);
          const pdfjs = await loadPdf();
          const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
          try {
            const text = await pdfToText(doc, Math.floor(remaining / Math.max(1, pending)), () => signal.aborted);
            const scanned = text.textPages < Math.max(1, Math.ceil(text.pages / 2));
            if (text.textPages > 0) {
              const cut = addText(`${name} (PDF, ${text.pages} pages)`, text.text, "Ask for specific pages or a specific part");
              note(`read ${text.textPages} of ${text.pages} pages as text${cut || text.truncated ? " (cut to fit)" : ""}`);
            }
            if (scanned) {
              // Pages with no text layer: show them, or have them described.
              const need: number[] = [];
              for (let n = 1; n <= Math.min(text.pages, MAX_RENDERED_PAGES); n++) need.push(n);
              const render = env.renderPage ?? renderPdfPage;
              const images: Array<{ data: string; mimeType: string; n: number }> = [];
              for (const n of need) {
                if (signal.aborted) break;
                const img = await render(doc, n);
                if (img?.data) images.push({ ...img, n });
              }
              if (images.length && profile.vision) {
                for (const img of images) outParts.push({ type: "image", data: img.data, mimeType: img.mimeType, name: `${name} page ${img.n}` });
                blocks.push(`[${name} has pages with no text layer (scanned). The first ${images.length} page image(s) are shown to you${text.pages > images.length ? `; the document has ${text.pages} pages` : ""}.]`);
                note(`scanned: ${images.length} page(s) drawn and shown`);
              } else if (images.length) {
                notice(`Reading scanned pages of ${name} with a vision model…`);
                const described: string[] = [];
                for (let i = 0; i < images.length; i += 4) {
                  const batch = images.slice(i, i + 4);
                  const out = await args.describe(
                    [
                      { role: "system", content: DESCRIBE_SYSTEM },
                      { role: "user", content: `These are pages ${batch[0].n}–${batch[batch.length - 1].n} of the document "${name}". Transcribe each page in order, starting each with [Page N].`, parts: batch.map((b) => ({ type: "image" as const, data: b.data, mimeType: b.mimeType, name: `${name} page ${b.n}` })) },
                    ],
                    signal
                  );
                  if (out) described.push(out);
                }
                if (described.length) {
                  addText(`${name} (scanned PDF, read by a vision model)`, described.join("\n\n"));
                  note(`scanned: ${images.length} page(s) read by a vision model`);
                } else {
                  blocks.push(`[The PDF "${name}" is scanned (no text layer) and this model cannot see images; no vision model is available to read it. Say so plainly.]`);
                  note("scanned, and nothing could read it");
                }
              } else if (text.textPages === 0) {
                blocks.push(`[The PDF "${name}" (${text.pages} pages) has no text layer and its pages could not be drawn. Say so plainly.]`);
                note("no text layer");
              }
            }
          } finally {
            doc.destroy?.();
          }
        }
      } else if (kind === "audio") {
        if (profile.providerType === "gemini") {
          outParts.push({ type: "audio", data: part.data, mimeType: mime, name });
          blocks.push(`[Attached audio: ${name} (${sizeLabel(bytes.length)}), given to you to listen to.]`);
          note("sent as audio");
        } else {
          notice(`Transcribing ${name}…`);
          const transcript = await args.describe(
            [
              { role: "system", content: TRANSCRIBE_SYSTEM },
              { role: "user", content: `Transcribe this audio (${name}).`, parts: [{ type: "audio", data: part.data, mimeType: mime, name }] },
            ],
            signal
          );
          if (transcript) {
            addText(`${name} (audio, transcribed)`, transcript);
            note("transcribed by another model");
          } else {
            blocks.push(`[The user attached audio: "${name}" (${sizeLabel(bytes.length)}). This model cannot listen and nothing is set up to transcribe it. Say so plainly.]`);
            note("could not be listened to");
          }
        }
      } else if (kind === "docx" || kind === "pptx" || kind === "xlsx") {
        const body = kind === "docx" ? extractDocx(bytes) : kind === "pptx" ? extractPptx(bytes) : extractXlsx(bytes);
        const cut = addText(`${name} (${kind.toUpperCase()})`, body || "(no text found)");
        note(`read as text (${body.length} characters${cut ? ", cut to fit" : ""})`);
      } else if (kind === "text") {
        const body = decodeText(bytes);
        const cut = addText(name, body);
        note(`read as text (${body.length} characters${cut ? ", cut to fit" : ""})`);
      } else {
        blocks.push(`[The user attached "${name}" (${mime || "unknown type"}, ${sizeLabel(bytes.length)}), a kind of file Agenter cannot read. Say so plainly.]`);
        note("cannot be read");
      }
    } catch (error: any) {
      blocks.push(`[The attachment "${name}" could not be read: ${String(error?.message ?? error).slice(0, 160)}. Say so plainly.]`);
      note(`failed: ${String(error?.message ?? error).slice(0, 120)}`);
    }
    pending--;
  }

  const content = blocks.length ? `${blocks.join("\n\n")}\n\n${args.text}` : args.text;
  return { content, parts: outParts, notes };
}
