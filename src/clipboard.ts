// ── clipboard.ts ──────────────────────────────────────────────────────────
// Copying text out of the chat: a message as written (Markdown) or as read
// (plain text), a selection, a whole conversation. The system clipboard API
// is used where it is allowed; where it is not (a focus rule, an older
// webview) a hidden textarea and the old copy command do the same.
// ─────────────────────────────────────────────────────────────────────────────

export async function copyText(text: string, doc: Document = document): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the old way */
  }
  try {
    const area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    area.style.pointerEvents = "none";
    doc.body.appendChild(area);
    area.select();
    const ok = doc.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** What the person has selected inside `root`, if anything. */
export function selectedTextWithin(root: HTMLElement): string {
  const selection = root.ownerDocument.defaultView?.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return "";
  return selection.toString();
}

export function selectContents(el: HTMLElement): void {
  const doc = el.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (!selection) return;
  const range = doc.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** A message as plain text: what is read, without the Markdown marks. */
export function plainTextOf(el: HTMLElement | null, fallback: string): string {
  const text = el?.innerText ?? el?.textContent ?? "";
  return text.trim() || fallback;
}

export interface TranscriptEntry {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  toolName?: string;
}

/** A conversation as Markdown, for pasting into a note or a bug report. */
export function transcriptMarkdown(entries: TranscriptEntry[], title = "Agenter conversation"): string {
  const lines: string[] = [`# ${title}`, ""];
  for (const e of entries) {
    if (e.role === "user") lines.push("## You", "", e.text, "");
    else if (e.role === "assistant") lines.push("## Agenter", "", e.text, "");
    else if (e.role === "tool") lines.push(`> **Tool: ${e.toolName ?? "tool"}**`, "", "```", e.text.length > 2000 ? `${e.text.slice(0, 2000)}\n…` : e.text, "```", "");
    else lines.push(`> ${e.text.replace(/\n/g, "\n> ")}`, "");
  }
  return lines.join("\n").trimEnd() + "\n";
}
