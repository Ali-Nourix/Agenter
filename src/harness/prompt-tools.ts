// ── harness/prompt-tools.ts ───────────────────────────────────────────────
// Some models cannot be given tools through the API: the server answers that
// the model "does not support tools". They can still be agents if the tools
// are described in the prompt and the model is asked to write its calls in a
// fixed form that the harness reads back (the form most open models were
// trained on). The conversation is translated for such a model only for the
// request: tool calls become the text the model wrote, and results become
// user messages, since a model without tool support has no "tool" role.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChatMessage, ToolDefinition } from "../api";

export function promptToolsAddendum(tools: ToolDefinition[]): string {
  if (!tools.length) return "";
  const listing = tools
    .map((t) => `- ${t.name}: ${t.description}\n  parameters (JSON schema): ${JSON.stringify(t.parameters)}`)
    .join("\n");
  return [
    "",
    "## Calling tools",
    "You can use the tools listed below. To call a tool, write exactly this, with nothing else on those lines:",
    '<tool_call>{"name": "<tool name>", "arguments": {<arguments as JSON>}}</tool_call>',
    "You may write one short sentence before a call. Write one <tool_call> block per call, then stop and wait: the result comes back in the next message inside <tool_response> tags. Never invent a result. When you have what you need, answer the user normally, without a <tool_call> block.",
    "",
    "Available tools:",
    listing,
  ].join("\n");
}

/** The same conversation without the tool role: calls written out, results as user messages. */
export function toPromptMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      const calls = m.tool_calls
        .map((c) => `<tool_call>${JSON.stringify({ name: c.name, arguments: safeObject(c.arguments) })}</tool_call>`)
        .join("\n");
      out.push({ role: "assistant", content: [m.content?.trim(), calls].filter(Boolean).join("\n") });
    } else if (m.role === "tool") {
      const body = `<tool_response name="${m.tool_name ?? "tool"}">\n${m.content ?? ""}\n</tool_response>`;
      const last = out[out.length - 1];
      // Several results of one round are one message.
      if (last && last.role === "user" && last.metadata?.kind === "tool-results") last.content += `\n${body}`;
      else out.push({ role: "user", content: body, metadata: { kind: "tool-results" } });
    } else {
      out.push({ ...m, tool_calls: undefined });
    }
  }
  return out;
}

function safeObject(s: string): unknown {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}
