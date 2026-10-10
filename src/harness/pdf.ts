// ── harness/pdf.ts ────────────────────────────────────────────────────────
// Reading a PDF so that a model can understand it. pdf.js hands over text as
// a pile of small items with positions, and in real files that pile is not
// text yet: a Persian word arrives as separate glyphs in the *visual* order
// (left to right) written in presentation forms, a ligature such as "fl" is
// an item of its own, a table row is a few items on one baseline. Gluing the
// items together in stream order with spaces, as a first version does,
// produces "ی ﻠ ﺼ ﻓ ارش ﺰ گ" for "گزارش فصلی" and "fl at" for "flat".
//
// So the page is laid out again: items are put into lines by their position,
// each line is put back into reading order with its bidirectional runs, the
// glyphs are normalised to the letters they stand for, and a gap that is
// wide enough is a space or a column. A page is also judged: text that is
// mostly private-use characters or replacement marks has no usable text layer
// and is treated like a scan.
//
// A PDF too large for a window is read in pieces: an overview with the first
// words of every page, pages by number, a search that says which pages
// mention something. The model asks for these through the read_pdf tool.
// ─────────────────────────────────────────────────────────────────────────────

import { truncateMiddle } from "./tool-output";

// ── what is used of pdf.js ────────────────────────────────────────────────

export interface PdfTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  dir?: string;
  hasEOL?: boolean;
}

export interface PdfPageLike {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: { canvasContext: unknown; viewport: unknown }): { promise: Promise<void> };
}

export interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
  getMetadata?: () => Promise<{ info?: Record<string, unknown> }>;
  destroy?: () => void;
}

/** The part of pdf.js that is used. Obsidian provides it through `loadPdfJs()`. */
export interface PdfJsLike {
  getDocument(src: { data: Uint8Array } | Uint8Array): { promise: Promise<PdfDocLike> };
}

// ── characters ────────────────────────────────────────────────────────────

type Strength = "R" | "L" | "N";

const RTL_LETTER = /[֐-׿؀-؅؈؋؍-؟ؠ-ي٭-ٯٱ-ەۥ-ۦۮ-ۯۺ-ۿ܀-ࣿיִ-﷿ﹰ-﻿]/;
const DIGIT = /\p{Nd}/u;
const MARK_ONLY = /^\s*[\p{M}ـ]+\s*$/u;
/** Controls and marks that carry no text: directional marks, zero-width joiners kept (they matter in Persian). */
const NOISE = /[‎‏‪-‮⁦-⁩﻿­]/g;

function strengthOf(ch: string): Strength {
  if (RTL_LETTER.test(ch)) return "R";
  if (DIGIT.test(ch)) return "L";
  if (/\p{L}/u.test(ch)) return "L";
  return "N";
}

function itemStrength(text: string): Strength {
  let r = 0;
  let l = 0;
  for (const ch of text) {
    const s = strengthOf(ch);
    if (s === "R") r++;
    else if (s === "L") l++;
  }
  if (!r && !l) return "N";
  return r >= l ? "R" : "L";
}

/** Letters as written, not as drawn: Arabic presentation forms and ligatures become the letters they stand for. */
export function normalizePdfText(text: string): string {
  return text.normalize("NFKC").replace(NOISE, "");
}

/** The text with the differences that do not matter for finding something removed (Arabic and Persian letter variants, marks, case). */
export function foldForSearch(text: string): string {
  return normalizePdfText(text)
    .replace(/[يىی]/g, "ی")
    .replace(/[كک]/g, "ک")
    .replace(/[ةۀ]/g, "ه")
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[ً-ٰٟـ‌‍]/g, "")
    .toLowerCase();
}

// ── laying a page out again ───────────────────────────────────────────────

interface Box {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  mark: boolean;
  strength: Strength;
}

function hasPositions(items: PdfTextItem[]): boolean {
  let positioned = 0;
  for (const item of items) if (Array.isArray(item.transform) && item.transform.length >= 6 && typeof item.width === "number") positioned++;
  return positioned > 0 && positioned >= items.filter((i) => (i.str ?? "").length > 0).length;
}

function upright(item: PdfTextItem): boolean {
  const t = item.transform!;
  return Math.abs(t[1]) < 0.2 * Math.abs(t[0] || 1) && Math.abs(t[2]) < 0.2 * Math.abs(t[3] || 1);
}

/** Text from items that carry no positions (or are rotated): in the order given, a space between items, a line where the item ends one. */
function streamText(items: PdfTextItem[]): string {
  let text = "";
  for (const item of items) {
    text += item.str ?? "";
    text += item.hasEOL ? "\n" : " ";
  }
  return text.replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function toBoxes(items: PdfTextItem[]): Box[] {
  const boxes: Box[] = [];
  for (const item of items) {
    let text = item.str ?? "";
    if (!text) continue;
    const t = item.transform!;
    const mark = MARK_ONLY.test(text);
    if (mark) text = text.trim();
    else text = text.replace(/ /g, " ");
    const normalized = normalizePdfText(text);
    if (!normalized) continue;
    const h = Math.abs(item.height || t[3] || 0) || Math.abs(t[3]) || 10;
    boxes.push({ text: normalized, x: t[4], y: t[5], w: Math.max(0, item.width ?? 0), h, mark, strength: itemStrength(normalized) });
  }
  return boxes;
}

interface Line { boxes: Box[]; y: number; h: number }

function toLines(boxes: Box[]): Line[] {
  const real = boxes.filter((b) => !b.mark && b.text.trim());
  const body = median(real.map((b) => b.h)) || 10;
  const sorted = [...boxes].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const box of sorted) {
    const tolerance = Math.max(2, Math.min(box.h, body) * 0.45);
    const line = lines.find((l) => Math.abs(l.y - box.y) <= tolerance);
    if (line) {
      line.boxes.push(box);
      line.h = Math.max(line.h, box.mark ? 0 : box.h);
    } else {
      lines.push({ boxes: [box], y: box.y, h: box.mark ? 0 : box.h });
    }
  }
  for (const line of lines) if (!line.h) line.h = body;
  return lines.sort((a, b) => b.y - a.y);
}

interface Run { strength: Strength; boxes: Box[] }

/** Brackets and quotes are drawn mirrored in right-to-left text, so the file holds the character that looks right, not the one that was typed. */
const MIRROR: Record<string, string> = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<", "«": "»", "»": "«", "‹": "›", "›": "‹" };
function mirrored(text: string): string {
  let out = "";
  for (const ch of text) out += MIRROR[ch] ?? ch;
  return out;
}

/** A mark (a hamza above a letter, a vowel sign) belongs to the letter it sits on: it is folded into that item. */
function attachMarks(boxes: Box[]): Box[] {
  const bases = boxes.filter((b) => !b.mark);
  if (!bases.length) return boxes.filter((b) => !b.mark || b.text);
  for (const mark of boxes) {
    if (!mark.mark) continue;
    let best: Box | null = null;
    let bestDistance = Infinity;
    for (const base of bases) {
      if (!base.text.trim()) continue;
      const centre = base.x + base.w / 2;
      const inside = mark.x >= base.x - 1.5 && mark.x <= base.x + base.w + 1.5;
      const distance = inside ? Math.abs(mark.x - centre) : 1000 + Math.min(Math.abs(mark.x - base.x), Math.abs(mark.x - (base.x + base.w)));
      if (Math.abs(mark.y - base.y) > Math.max(6, base.h) ) continue;
      if (distance < bestDistance) { best = base; bestDistance = distance; }
    }
    if (best) best.text += mark.text;
  }
  return bases;
}

/** One line, in reading order: the glyphs are in visual order, left to right; a run of right-to-left text is read from its right end. */
function lineText(line: Line): string {
  const visual = attachMarks(line.boxes).sort((a, b) => a.x - b.x);
  const position = new Map<Box, number>();
  visual.forEach((box, index) => position.set(box, index));

  let rtl = 0;
  let ltr = 0;
  for (const box of visual) {
    for (const ch of box.text) {
      const strength = strengthOf(ch);
      if (strength === "R") rtl++;
      else if (strength === "L") ltr++;
    }
  }
  const base: Strength = rtl > ltr ? "R" : "L";

  // Runs of one direction; a neutral item (a space, a dash) joins the run before it.
  const runs: Run[] = [];
  for (const box of visual) {
    const strength = box.strength;
    const last = runs[runs.length - 1];
    if (strength === "N") {
      if (last) last.boxes.push(box);
      else runs.push({ strength: "N", boxes: [box] });
      continue;
    }
    if (last && (last.strength === strength || last.strength === "N")) {
      last.strength = strength;
      last.boxes.push(box);
    } else {
      runs.push({ strength, boxes: [box] });
    }
  }
  for (const run of runs) if (run.strength === "N") run.strength = base;
  const merged: Run[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && last.strength === run.strength) last.boxes.push(...run.boxes);
    else merged.push({ strength: run.strength, boxes: [...run.boxes] });
  }

  const ordered = base === "R" ? [...merged].reverse() : merged;
  const sequence: Array<{ box: Box; text: string }> = [];
  for (const run of ordered) {
    const boxes = run.strength === "R" ? [...run.boxes].reverse() : run.boxes;
    for (const box of boxes) sequence.push({ box, text: run.strength === "R" ? mirrored(box.text) : box.text });
  }

  // Join. Items that touch are one word; a space item is a space; a gap is a space, a wide one a column. Two items that
  // were not side by side on the page (the join of two runs) are separated by a space.
  let out = "";
  let previous: { box: Box; text: string } | null = null;
  const space = Math.max(1.5, line.h * 0.22);
  const column = Math.max(10, line.h * 1.6);
  for (const current of sequence) {
    const { box, text } = current;
    if (!text.trim()) {
      out += box.w > column ? " | " : " ";
      previous = current;
      continue;
    }
    if (previous) {
      const joined = /[\s|]$/.test(out) || /^\s/.test(text);
      if (!joined) {
        const sideBySide = Math.abs((position.get(previous.box) ?? 0) - (position.get(box) ?? 0)) === 1;
        if (!sideBySide) out += " ";
        else {
          const gap = previous.box.x < box.x ? box.x - (previous.box.x + previous.box.w) : previous.box.x - (box.x + box.w);
          if (gap > column) out += " | ";
          else if (gap > space) out += " ";
        }
      }
    }
    out += text;
    previous = current;
  }
  return out.replace(/[ \t]{2,}/g, " ").replace(/^\s*\|\s*|\s*\|\s*$/g, "").trim();
}

/** The text of one page, laid out again from its items. */
export function layoutPageText(items: PdfTextItem[]): string {
  const usable = items.filter((i) => (i.str ?? "").length > 0 || i.hasEOL);
  if (!usable.length) return "";
  if (!hasPositions(usable) || !usable.filter((i) => (i.str ?? "").length > 0).every((i) => !i.transform || upright(i))) {
    return streamText(items);
  }
  const lines = toLines(toBoxes(items));
  const out: string[] = [];
  let previous: Line | null = null;
  for (const line of lines) {
    const text = lineText(line);
    if (!text) continue;
    if (previous) {
      const gap = previous.y - line.y;
      if (gap > previous.h * 1.75) out.push("");
    }
    out.push(text);
    previous = line;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── is it text? ───────────────────────────────────────────────────────────

export interface TextQuality {
  /** Characters that are not whitespace. */
  chars: number;
  readable: boolean;
}

/** Text that is mostly private-use or replacement characters is a font without a usable map: no text layer. */
export function judgeText(text: string): TextQuality {
  const compact = text.replace(/\s+/g, "");
  const chars = compact.length;
  if (!chars) return { chars, readable: false };
  let letters = 0;
  let bad = 0;
  for (const ch of compact) {
    if (/[\p{L}\p{N}]/u.test(ch)) letters++;
    const code = ch.codePointAt(0)!;
    if (ch === "�" || (code >= 0xe000 && code <= 0xf8ff) || (code < 32 && ch !== "\t")) bad++;
  }
  const cid = (text.match(/\(cid:\d+\)/g) ?? []).length;
  if (cid > 3) return { chars, readable: false };
  // A few characters ("Chapter 1", "iii") are text if they are clean; more must be mostly letters and digits.
  return { chars, readable: bad / chars < 0.1 && letters / chars > (chars < 12 ? 0.3 : 0.45) };
}

// ── page ranges ───────────────────────────────────────────────────────────

/** "1-3, 7, 10-" → [1,2,3,7,10,…]. Out-of-range pages are dropped; "all" is every page. */
export function parsePageRanges(spec: string | undefined, total: number): number[] {
  const text = String(spec ?? "").trim().toLowerCase();
  if (!text) return [];
  if (text === "all") return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>();
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const range = /^(\d*)\s*[-–:]\s*(\d*)$/.exec(part);
    if (range) {
      const from = range[1] ? Number(range[1]) : 1;
      const to = range[2] ? Number(range[2]) : total;
      for (let n = Math.max(1, Math.min(from, to)); n <= Math.min(total, Math.max(from, to)); n++) pages.add(n);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n >= 1 && n <= total) pages.add(n);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

/** Compact "1-3, 7, 9-12" for a list of page numbers. */
export function describePages(pages: number[]): string {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < pages.length; i++) {
    if (i === 0) { start = pages[0]; continue; }
    if (pages[i] !== pages[i - 1] + 1) {
      out.push(start === pages[i - 1] ? String(start) : `${start}-${pages[i - 1]}`);
      start = pages[i];
    }
  }
  if (pages.length) out.push(start === pages[pages.length - 1] ? String(start) : `${start}-${pages[pages.length - 1]}`);
  return out.join(", ");
}

// ── a document ────────────────────────────────────────────────────────────

export interface PdfPageText {
  n: number;
  text: string;
  chars: number;
  readable: boolean;
}

export interface PdfImage {
  data: string;
  mimeType: string;
}

export type PageRenderer = (doc: PdfDocLike, n: number, maxSide?: number) => Promise<PdfImage | null>;

/** A page of a PDF drawn as a JPEG, base64 without the prefix. Needs a DOM. */
export const renderPdfPage: PageRenderer = async (doc, n, maxSide = 1600) => {
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
};

export class PdfReader {
  private cache = new Map<number, PdfPageText>();

  constructor(
    readonly doc: PdfDocLike,
    readonly name: string,
    private readonly renderer: PageRenderer = renderPdfPage
  ) {}

  get pages(): number {
    return this.doc.numPages;
  }

  async page(n: number): Promise<PdfPageText> {
    const hit = this.cache.get(n);
    if (hit) return hit;
    let text = "";
    try {
      const page = await this.doc.getPage(n);
      const content = await page.getTextContent();
      text = layoutPageText(content.items ?? []);
    } catch (error) {
      text = "";
    }
    const quality = judgeText(text);
    const result: PdfPageText = { n, text: quality.readable ? text : "", chars: quality.readable ? quality.chars : 0, readable: quality.readable };
    this.cache.set(n, result);
    return result;
  }

  async title(): Promise<string> {
    try {
      const meta = await this.doc.getMetadata?.();
      const title = meta?.info?.Title;
      return typeof title === "string" ? normalizePdfText(title).trim() : "";
    } catch {
      return "";
    }
  }

  /** Reads pages in order until `maxChars`, whole pages only (the last one cut if it alone is too long). */
  async read(pages: number[], maxChars: number, shouldStop?: () => boolean): Promise<{ text: string; shown: number[]; stoppedBefore?: number; empty: number[] }> {
    const parts: string[] = [];
    const shown: number[] = [];
    const empty: number[] = [];
    let total = 0;
    let stoppedBefore: number | undefined;
    for (const n of pages) {
      if (shouldStop?.()) { stoppedBefore = n; break; }
      const page = await this.page(n);
      if (!page.readable) { empty.push(n); continue; }
      const block = `[Page ${n}]\n${page.text}`;
      if (total + block.length > maxChars) {
        if (!shown.length) {
          const cut = truncateMiddle(block, maxChars, `Ask for a smaller part of page ${n}`);
          parts.push(cut.text);
          shown.push(n);
          total += cut.text.length;
          continue;
        }
        stoppedBefore = n;
        break;
      }
      parts.push(block);
      shown.push(n);
      total += block.length + 2;
    }
    return { text: parts.join("\n\n"), shown, stoppedBefore, empty };
  }

  /**
   * The first words of each page, to find one's way around. A long document is not read through for this: the first pages
   * are, and a few spread over the rest tell roughly how much text there is.
   */
  async overview(limitPages = 80): Promise<{ lines: string[]; unreadable: number[]; totalChars: number; sampled: boolean }> {
    const lines: string[] = [];
    const unreadable: number[] = [];
    const total = this.pages;
    const examined = new Set<number>();
    for (let n = 1; n <= Math.min(total, limitPages); n++) examined.add(n);
    let sampled = false;
    if (total > limitPages) {
      sampled = true;
      const step = Math.max(1, Math.floor((total - limitPages) / 12));
      for (let n = limitPages + step; n <= total; n += step) examined.add(n);
    }
    let chars = 0;
    for (const n of [...examined].sort((a, b) => a - b)) {
      const page = await this.page(n);
      chars += page.chars;
      if (!page.readable) {
        unreadable.push(n);
        if (n <= limitPages) lines.push(`${n}: (no text layer)`);
        continue;
      }
      if (n <= limitPages) {
        const first = page.text.split("\n").map((t) => t.trim()).filter(Boolean).slice(0, 2).join(" — ");
        lines.push(`${n}: ${first.length > 110 ? first.slice(0, 107) + "…" : first}`);
      }
    }
    const totalChars = sampled ? Math.round((chars / examined.size) * total) : chars;
    return { lines, unreadable, totalChars, sampled };
  }

  async search(query: string, limit = 15): Promise<Array<{ page: number; hits: number; snippet: string }>> {
    const needle = foldForSearch(query).trim();
    if (!needle) return [];
    const found: Array<{ page: number; hits: number; snippet: string }> = [];
    for (let n = 1; n <= this.pages && found.length < limit; n++) {
      const page = await this.page(n);
      if (!page.readable) continue;
      const hay = foldForSearch(page.text);
      let hits = 0;
      let at = hay.indexOf(needle);
      const first = at;
      while (at >= 0 && hits < 500) { hits++; at = hay.indexOf(needle, at + needle.length); }
      if (!hits) continue;
      // The snippet comes from the original text: folding keeps lengths mostly, so the position is a good guide.
      const original = page.text;
      const centre = Math.min(original.length, Math.max(0, first));
      const from = Math.max(0, centre - 70);
      const snippet = original.slice(from, centre + needle.length + 90).replace(/\s+/g, " ").trim();
      found.push({ page: n, hits, snippet: `${from > 0 ? "…" : ""}${snippet}${centre + needle.length + 90 < original.length ? "…" : ""}` });
    }
    return found;
  }

  async render(n: number, maxSide?: number): Promise<PdfImage | null> {
    try {
      return await this.renderer(this.doc, n, maxSide);
    } catch {
      return null;
    }
  }

  destroy(): void {
    try { this.doc.destroy?.(); } catch { /* already gone */ }
  }
}

// ── the documents a chat has ──────────────────────────────────────────────

const MAX_OPEN = 3;

export class PdfLibrary {
  private open = new Map<string, PdfReader>();
  private attached = new Map<string, { name: string; bytes: Uint8Array }>();

  constructor(
    private load: () => Promise<PdfJsLike>,
    private renderer: PageRenderer = renderPdfPage
  ) {}

  setLoader(load: () => Promise<PdfJsLike>): void {
    this.load = load;
  }

  /** A PDF the person attached: kept in memory for as long as the chat is open, so that pages can be read later. */
  addAttachment(name: string, bytes: Uint8Array): void {
    const key = name.toLowerCase();
    this.attached.delete(key);
    this.attached.set(key, { name, bytes });
    const old = this.open.get(`attachment:${name}`);
    if (old) { old.destroy(); this.open.delete(`attachment:${name}`); }
    // Kept in memory: a handful of documents, and not more than about 96 MB of them.
    let bytesHeld = 0;
    for (const entry of this.attached.values()) bytesHeld += entry.bytes.length;
    while (this.attached.size > 8 || (this.attached.size > 1 && bytesHeld > 96 * 1024 * 1024)) {
      const first = this.attached.keys().next().value as string;
      bytesHeld -= this.attached.get(first)!.bytes.length;
      this.attached.delete(first);
    }
  }

  attachmentNames(): string[] {
    return [...this.attached.values()].map((a) => a.name);
  }

  findAttachment(name?: string): { name: string; bytes: Uint8Array } | { error: string } {
    const all = [...this.attached.values()];
    if (!all.length) return { error: "No PDF has been attached to this chat. Use find_pdfs to look for one in the vault and give its path." };
    const wanted = String(name ?? "").trim().toLowerCase();
    if (!wanted) {
      if (all.length === 1) return all[0];
      return { error: `Several PDFs are attached (${all.map((a) => a.name).join(", ")}). Say which with "attachment".` };
    }
    const found = all.find((a) => a.name.toLowerCase() === wanted) ?? all.find((a) => a.name.toLowerCase().includes(wanted) || wanted.includes(a.name.toLowerCase()));
    if (!found) return { error: `No attached PDF is called "${name}". Attached: ${all.map((a) => a.name).join(", ")}.` };
    return found;
  }

  async reader(key: string, bytes: Uint8Array, label: string): Promise<PdfReader> {
    const hit = this.open.get(key);
    if (hit) { this.open.delete(key); this.open.set(key, hit); return hit; }
    const pdfjs = await this.load();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    const reader = new PdfReader(doc, label, this.renderer);
    this.open.set(key, reader);
    while (this.open.size > MAX_OPEN) {
      const oldest = this.open.keys().next().value as string;
      this.open.get(oldest)?.destroy();
      this.open.delete(oldest);
    }
    return reader;
  }

  closeAll(): void {
    for (const reader of this.open.values()) reader.destroy();
    this.open.clear();
  }
}

// ── the read_pdf tool ─────────────────────────────────────────────────────

export interface ReadPdfArgs {
  path?: string;
  attachment?: string;
  pages?: string;
  query?: string;
  view?: boolean;
}

export interface ReadPdfEnv {
  library: PdfLibrary;
  /** A PDF in the vault: its bytes and a key that changes when the file does. Null when there is no such file. */
  readVault: (path: string) => Promise<{ bytes: Uint8Array; key: string } | null>;
  /** The model can be shown pictures. */
  vision: boolean;
  /** Another model describes pictures (and reads the text in them) for one that cannot see. */
  describe?: (images: Array<{ data: string; mimeType: string; page: number }>, name: string) => Promise<string | null>;
  /** Characters one call may return. */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 24_000;
const FULL_TEXT_LIMIT = 14_000;
const MAX_IMAGES_PER_CALL = 4;

function imageLine(name: string, image: PdfImage): string {
  return JSON.stringify({ name, mime: image.mimeType, dataUri: `data:${image.mimeType};base64,${image.data}` });
}

/** What the model sees of some pages as pictures: the pictures themselves, or a description, or why neither. */
async function pagesAsPictures(reader: PdfReader, pages: number[], env: ReadPdfEnv, label: string): Promise<string> {
  const take = pages.slice(0, MAX_IMAGES_PER_CALL);
  const images: Array<{ data: string; mimeType: string; page: number }> = [];
  for (const n of take) {
    const image = await reader.render(n);
    if (image?.data) images.push({ ...image, page: n });
  }
  const lines: string[] = [];
  if (!images.length) {
    lines.push(`Page${take.length > 1 ? "s" : ""} ${describePages(take)} of ${label} could not be drawn here.`);
  } else if (env.vision) {
    for (const image of images) lines.push(imageLine(`${label} page ${image.page}`, image));
  } else if (env.describe) {
    const described = await env.describe(images, label);
    if (described) lines.push(`[Pages ${describePages(images.map((i) => i.page))} of ${label}, read by a vision model]\n${described}`);
    else lines.push(`Pages ${describePages(take)} of ${label} have no readable text and this model cannot see images; no vision model is available to read them. Say so plainly.`);
  } else {
    lines.push(`Pages ${describePages(take)} of ${label} have no readable text and this model cannot see images; no vision model is available to read them. Say so plainly.`);
  }
  if (pages.length > take.length) lines.push(`(${pages.length - take.length} more such pages: ask for them in another call, ${MAX_IMAGES_PER_CALL} at a time.)`);
  return lines.join("\n");
}

export async function readPdfTool(args: ReadPdfArgs, env: ReadPdfEnv): Promise<string> {
  // Which document.
  let reader: PdfReader;
  let label: string;
  try {
    if (args.path) {
      const found = await env.readVault(String(args.path));
      if (!found) return `PDF not found: ${args.path}. Use find_pdfs to list the PDFs in the vault.`;
      label = String(args.path).split("/").pop() || String(args.path);
      reader = await env.library.reader(`vault:${found.key}`, found.bytes, label);
    } else {
      const found = env.library.findAttachment(args.attachment);
      if ("error" in found) return found.error;
      label = found.name;
      reader = await env.library.reader(`attachment:${found.name}`, found.bytes, label);
    }
  } catch (error: any) {
    return `The PDF could not be opened: ${String(error?.message ?? error).slice(0, 200)}`;
  }

  const maxChars = env.maxChars ?? DEFAULT_MAX_CHARS;
  const total = reader.pages;
  const wanted = parsePageRanges(args.pages, total);

  // A picture of pages: figures, tables, layout that text loses.
  if (args.view) {
    const pages = wanted.length ? wanted : [1];
    return pagesAsPictures(reader, pages, env, label);
  }

  // Which pages mention it.
  if (args.query && String(args.query).trim()) {
    const hits = await reader.search(String(args.query));
    if (!hits.length) {
      const overview = await reader.overview(0);
      const note = overview.unreadable.length ? ` ${overview.unreadable.length} page(s) have no text layer and could not be searched.` : "";
      return `"${args.query}" does not appear in the text of ${label} (${total} pages).${note}`;
    }
    const lines = hits.map((h) => `Page ${h.page}${h.hits > 1 ? ` (${h.hits} times)` : ""}: ${h.snippet}`);
    return `"${args.query}" in ${label} (${total} pages):\n${lines.join("\n")}\n\nRead a page with read_pdf and pages "${hits[0].page}".`;
  }

  // Pages by number.
  if (wanted.length) {
    const result = await reader.read(wanted, maxChars);
    const out: string[] = [];
    if (result.text) out.push(result.text);
    if (result.empty.length) {
      out.push(await pagesAsPictures(reader, result.empty, env, label));
    }
    if (result.stoppedBefore !== undefined) {
      const rest = wanted.filter((n) => n >= result.stoppedBefore!);
      out.push(`[Stopped after page ${result.shown[result.shown.length - 1]}: that is as much as one call returns. Continue with pages "${describePages(rest)}".]`);
    }
    if (!out.length) out.push(`No text could be read from pages ${describePages(wanted)} of ${label}.`);
    return out.join("\n\n");
  }

  // The whole of a short one; the way round a long one.
  const overview = await reader.overview();
  if (overview.totalChars > 0 && overview.totalChars <= FULL_TEXT_LIMIT) {
    const all = await reader.read(Array.from({ length: total }, (_, i) => i + 1), maxChars);
    const extra = all.empty.length ? `\n\n${await pagesAsPictures(reader, all.empty, env, label)}` : "";
    return `${label}: ${total} page${total === 1 ? "" : "s"}.\n\n${all.text}${extra}`;
  }
  const title = await reader.title();
  const readable = total - overview.unreadable.length;
  const head = [
    `${label}: ${total} pages${title ? `, titled "${title}"` : ""}${overview.sampled ? "" : `; ${readable} with text${overview.unreadable.length ? `, ${overview.unreadable.length} without (scanned or drawn: ${describePages(overview.unreadable.slice(0, 40))}${overview.unreadable.length > 40 ? ", …" : ""})` : ""}`}.`,
    `About ${Math.round(overview.totalChars / 4).toLocaleString("en-US")} tokens of text in all${overview.sampled ? " (estimated from the first 80 pages and a sample of the rest)" : ""}.${overview.sampled && overview.unreadable.length ? ` Pages without a text layer among those looked at: ${describePages(overview.unreadable.slice(0, 40))}.` : ""}`,
    "",
    `The first words of ${total > 80 ? "the first 80 pages" : "each page"}:`,
    ...overview.lines,
    "",
    `To read: read_pdf with pages "1-5" (up to about ${Math.round(maxChars / 1000)}k characters a call). To find something: read_pdf with query "…". For a figure or a table as it looks: read_pdf with pages "3" and view true.`,
  ];
  return head.join("\n");
}
