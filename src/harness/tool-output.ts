// ── harness/tool-output.ts ────────────────────────────────────────────────
// What a tool returns goes into the conversation and stays there for every
// request that follows, so its size is the size of the conversation. A
// whole long note, a page fetched from the web, or an image as a base64 data
// URI (a one-megabyte picture is over a million characters) can fill a
// window by themselves, and a model with a full window is a model that has
// forgotten its instructions. Output is cut to a share of the window, with a
// note that says what was left out and how to ask for it; images become
// image parts a model that can see receives properly, or a short note for
// one that cannot.
// ─────────────────────────────────────────────────────────────────────────────

import type { MessagePart } from "../provider-types";

export interface PreparedToolOutput {
  /** What goes into the tool message. */
  text: string;
  /** Images to show the model, in a message of their own after the tool results. */
  images: MessagePart[];
  truncated: boolean;
  originalChars: number;
  imagesFound: number;
}

/** Roughly how many characters a token is worth in the worst case (code, Persian, JSON). */
const CHARS_PER_TOKEN = 3;

export function toolOutputTokenBudget(contextWindow: number): number {
  return Math.max(1_500, Math.min(50_000, Math.floor(contextWindow * 0.2)));
}

interface DataUriLine { name?: string; mime?: string; dataUri?: string }

function extractImages(output: string, vision: boolean): { text: string; images: MessagePart[]; found: number } {
  const images: MessagePart[] = [];
  let found = 0;
  const lines = output.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.includes('"dataUri"')) {
      try {
        const item = JSON.parse(trimmed) as DataUriLine;
        const m = /^data:([^;,]+);base64,(.+)$/s.exec(item.dataUri ?? "");
        if (m) {
          found++;
          const kb = Math.round((m[2].length * 3) / 4 / 1024);
          const label = item.name ?? "image";
          if (vision) {
            images.push({ type: "image", mimeType: item.mime ?? m[1], data: m[2], name: label });
            kept.push(`[Image: ${label} (${item.mime ?? m[1]}, ${kb} KB), shown to you in the next message]`);
          } else {
            kept.push(`[Image: ${label} (${item.mime ?? m[1]}, ${kb} KB), not shown: this model cannot see images]`);
          }
          continue;
        }
      } catch { /* not that kind of line */ }
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), images, found };
}

/** A data URI anywhere else in the text is replaced by a note: it is never useful as text. */
function stripInlineDataUris(text: string): string {
  return text.replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{800,}/gi, (m) => `[base64 data omitted: ${Math.round(m.length / 1024)} KB]`);
}

export function truncateMiddle(text: string, maxChars: number, hint: string): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const note = `\n\n[… ${text.length - maxChars} of ${text.length} characters omitted from the middle. ${hint}]\n\n`;
  const budget = Math.max(200, maxChars - note.length);
  const head = Math.floor(budget * 0.7);
  const tail = budget - head;
  return { text: text.slice(0, head) + note + text.slice(text.length - tail), truncated: true };
}

const HINTS: Record<string, string> = {
  read_note: "Ask for one part with read_note_section, or look for specific text with search_notes",
  current_note: "Ask for one part with read_note_section, or look for specific text with search_notes",
  summarize_note: "Ask for one part with read_note_section",
  fetch_url: "Fetch a narrower page, or search for the specific part you need",
  web_search: "Narrow the query",
};

export function prepareToolOutput(
  name: string,
  output: string,
  opts: { contextWindow: number; vision: boolean }
): PreparedToolOutput {
  const original = String(output ?? "");
  const { text: withoutImages, images, found } = extractImages(original, opts.vision);
  const cleaned = stripInlineDataUris(withoutImages);
  const maxChars = toolOutputTokenBudget(opts.contextWindow) * CHARS_PER_TOKEN;
  const cut = truncateMiddle(cleaned, maxChars, HINTS[name] ?? "Ask for a smaller part of it");
  return {
    text: cut.text,
    images,
    truncated: cut.truncated,
    originalChars: original.length,
    imagesFound: found,
  };
}
