// ── harness/sanitize.ts ───────────────────────────────────────────────────
// A conversation has rules every provider enforces, in its own words: a tool
// result belongs to a tool call that came before it; a tool call has a
// result before the next turn; ids are present and unique; a message is not
// empty; the first turn is the user's. A stopped run, a restored chat or a
// compaction can leave a history that breaks one of them, and a provider
// either refuses it or, worse, answers from a muddled one. This puts the
// history right before every request and says what it had to do.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChatMessage, ToolCall } from "../api";

export interface SanitizeReport {
  orphanResultsDropped: number;
  missingResultsAdded: number;
  idsAssigned: number;
  emptyDropped: number;
  leadingDropped: number;
  accessNotesStripped: number;
}

export const INTERRUPTED_RESULT = "No result was recorded for this call: the run was interrupted before it finished. Call it again if it is still needed.";

const ACCESS_NOTE = /^\[(?:Initial context access|Context access)[\s\S]*?\]\n\n/;

function emptyReport(): SanitizeReport {
  return { orphanResultsDropped: 0, missingResultsAdded: 0, idsAssigned: 0, emptyDropped: 0, leadingDropped: 0, accessNotesStripped: 0 };
}

export function sanitizeConversation(
  input: ChatMessage[],
  opts: { stripStaleAccessNotes?: boolean } = {}
): { messages: ChatMessage[]; report: SanitizeReport } {
  const report = emptyReport();
  const out: ChatMessage[] = [];
  const usedIds = new Set<string>();
  let counter = 0;
  const freshId = () => {
    let id: string;
    do { id = `call_${++counter}`; } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };

  // The last user message keeps its access note: it describes the turn that is about to run.
  let lastUser = -1;
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i].role === "user") { lastUser = i; break; }
  }

  // Calls waiting for their results, with the id the history knew them by (it may have been replaced).
  let pending: Array<{ call: ToolCall; original: string | undefined }> = [];
  const flushMissing = () => {
    for (const { call } of pending) {
      out.push({ role: "tool", content: INTERRUPTED_RESULT, tool_call_id: call.id, tool_name: call.name });
      report.missingResultsAdded++;
    }
    pending = [];
  };

  input.forEach((original, index) => {
    const message: ChatMessage = { ...original };
    if (message.role === "tool") {
      const at = pending.findIndex((p) => p.original === (message.tool_call_id || undefined));
      if (at < 0) { report.orphanResultsDropped++; return; }
      const [{ call }] = pending.splice(at, 1);
      message.tool_call_id = call.id;
      if (!message.tool_name) message.tool_name = call.name;
      if (!String(message.content ?? "").trim()) message.content = "(the tool returned nothing)";
      out.push(message);
      return;
    }

    // Anything that is not a tool result closes the previous round of calls.
    flushMissing();

    if (message.role === "assistant") {
      let calls = message.tool_calls?.filter((c) => c && c.name) ?? [];
      if (calls.length) {
        const originals: Array<string | undefined> = [];
        calls = calls.map((c) => {
          let id = c.id;
          originals.push(c.id || undefined);
          if (!id || usedIds.has(id)) { id = freshId(); report.idsAssigned++; }
          else usedIds.add(id);
          return { ...c, id, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) };
        });
        message.tool_calls = calls;
        pending = calls.map((call, i) => ({ call, original: originals[i] }));
      } else {
        message.tool_calls = undefined;
      }
      const hasText = String(message.content ?? "").trim().length > 0;
      if (!hasText && !message.tool_calls) { report.emptyDropped++; return; }
      if (!hasText) message.content = "";
      out.push(message);
      return;
    }

    if (message.role === "user") {
      let content = String(message.content ?? "");
      if (opts.stripStaleAccessNotes && index !== lastUser && ACCESS_NOTE.test(content)) {
        content = content.replace(ACCESS_NOTE, "");
        report.accessNotesStripped++;
      }
      message.content = content;
      if (!content.trim() && !(message.parts && message.parts.length)) { report.emptyDropped++; return; }
    }
    out.push(message);
  });
  flushMissing();

  // The first turn after the system prompt is the user's.
  let firstReal = out.findIndex((m) => m.role !== "system" && m.role !== "developer");
  if (firstReal < 0) firstReal = out.length;
  let start = firstReal;
  while (start < out.length && out[start].role !== "user") start++;
  if (start > firstReal && start < out.length) {
    report.leadingDropped = start - firstReal;
    out.splice(firstReal, start - firstReal);
  }
  return { messages: out, report };
}

export function reportIsClean(report: SanitizeReport): boolean {
  return Object.values(report).every((n) => n === 0);
}

export function describeReport(report: SanitizeReport): string {
  const parts: string[] = [];
  if (report.orphanResultsDropped) parts.push(`${report.orphanResultsDropped} orphan tool result(s) dropped`);
  if (report.missingResultsAdded) parts.push(`${report.missingResultsAdded} missing tool result(s) filled in`);
  if (report.idsAssigned) parts.push(`${report.idsAssigned} tool call id(s) assigned`);
  if (report.emptyDropped) parts.push(`${report.emptyDropped} empty message(s) dropped`);
  if (report.leadingDropped) parts.push(`${report.leadingDropped} leading non-user message(s) dropped`);
  if (report.accessNotesStripped) parts.push(`${report.accessNotesStripped} stale access note(s) removed`);
  return parts.join(", ");
}
