// ── harness/text-tool-calls.ts ────────────────────────────────────────────
// Some models, especially open ones behind a server that does not translate
// their tool syntax, do call tools but write the call as text: a
// <tool_call> block, a [TOOL_CALLS] list, a bare JSON object with a name and
// arguments, a fenced block. Left alone that text is shown to the user as
// the answer and nothing runs. This finds those calls, so they run like any
// other, and keeps the text from being streamed to the screen first.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolCall, ToolDefinition } from "../api";
import { parseJsonLoose } from "./json-repair";

export interface ExtractedCalls {
  calls: ToolCall[];
  /** The text with the calls taken out of it. */
  text: string;
}

const NAME_KEYS = ["name", "tool", "tool_name", "function_name", "function", "action"];
const ARG_KEYS = ["arguments", "parameters", "args", "input", "params", "action_input"];

/** Lower-cases and drops separators, so `read-note`, `readNote` and `Read_Note` are one name. */
export function normalizeToolName(name: string): string {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The tool a model meant by `name`: the exact one, or the one it differs from only by case and separators. */
export function matchToolName(name: string, tools: Array<Pick<ToolDefinition, "name">>): string | null {
  if (tools.some((t) => t.name === name)) return name;
  const wanted = normalizeToolName(name.replace(/^(functions?|tools?)[.:/]/i, ""));
  if (!wanted) return null;
  const hit = tools.find((t) => normalizeToolName(t.name) === wanted);
  return hit ? hit.name : null;
}

function asCall(obj: any, tools: ToolDefinition[], index: number): ToolCall | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  let nameValue: unknown;
  let fn: any = obj;
  if (obj.function && typeof obj.function === "object") fn = obj.function;
  for (const key of NAME_KEYS) {
    if (typeof fn[key] === "string") { nameValue = fn[key]; break; }
  }
  if (typeof nameValue !== "string") return null;
  const name = matchToolName(nameValue, tools);
  if (!name) return null;
  let args: unknown = {};
  for (const key of ARG_KEYS) {
    if (fn[key] !== undefined) { args = fn[key]; break; }
    if (obj[key] !== undefined) { args = obj[key]; break; }
  }
  if (typeof args === "string") {
    const parsed = parseJsonLoose(args);
    args = parsed.ok ? parsed.value : {};
  }
  if (args === null || typeof args !== "object") args = {};
  const id = typeof obj.id === "string" && obj.id ? obj.id : `text-call-${index + 1}`;
  return { id, name, arguments: JSON.stringify(args) };
}

function collect(value: unknown, tools: ToolDefinition[], into: ToolCall[]): boolean {
  if (Array.isArray(value)) {
    let any = false;
    for (const item of value) any = collect(item, tools, into) || any;
    return any;
  }
  if (value && typeof value === "object") {
    const obj = value as any;
    if (Array.isArray(obj.tool_calls)) return collect(obj.tool_calls, tools, into);
    const call = asCall(obj, tools, into.length);
    if (call) { into.push(call); return true; }
  }
  return false;
}

const TAG_BLOCK = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/gi;
const FUNCTION_TAG = /<function(?:=|\s+name=["']?)([A-Za-z0-9_.:-]+)["']?>\s*([\s\S]*?)\s*(?:<\/function>|$)/gi;
const MISTRAL = /\[TOOL_CALLS\]\s*([\s\S]*)$/;
const PYTHON_TAG = /<\|python_tag\|>\s*([\s\S]*?)(?:<\|eom_id\|>|<\|eot_id\|>|$)/;
const FENCE = /```(?:tool_call|tool_calls|tool|function|json)?[ \t]*\n([\s\S]*?)\n?```/g;

/** Finds tool calls written as text, for the tools that exist. The text without them comes back too. */
export function extractTextToolCalls(text: string, tools: ToolDefinition[]): ExtractedCalls {
  const calls: ToolCall[] = [];
  if (!text || !tools.length) return { calls, text };
  let remaining = text;

  const strip = (pattern: RegExp, read: (m: RegExpExecArray) => boolean) => {
    pattern.lastIndex = 0;
    const ranges: Array<[number, number]> = [];
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(remaining)) !== null) {
      if (read(m)) ranges.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) pattern.lastIndex++;
    }
    for (const [from, to] of ranges.reverse()) remaining = remaining.slice(0, from) + remaining.slice(to);
  };

  strip(TAG_BLOCK, (m) => {
    const parsed = parseJsonLoose(m[1], { allowTruncated: false });
    return parsed.ok && collect(parsed.value, tools, calls);
  });
  strip(FUNCTION_TAG, (m) => {
    const name = matchToolName(m[1], tools);
    if (!name) return false;
    const parsed = parseJsonLoose(m[2]);
    const args = parsed.ok && parsed.value && typeof parsed.value === "object" ? parsed.value : {};
    calls.push({ id: `text-call-${calls.length + 1}`, name, arguments: JSON.stringify(args) });
    return true;
  });
  const mistral = MISTRAL.exec(remaining);
  if (mistral) {
    const parsed = parseJsonLoose(mistral[1]);
    if (parsed.ok && collect(parsed.value, tools, calls)) remaining = remaining.slice(0, mistral.index);
  }
  const python = PYTHON_TAG.exec(remaining);
  if (python) {
    const parsed = parseJsonLoose(python[1]);
    if (parsed.ok && collect(parsed.value, tools, calls)) remaining = remaining.replace(PYTHON_TAG, "");
  }
  if (!calls.length) {
    strip(FENCE, (m) => {
      const parsed = parseJsonLoose(m[1]);
      return parsed.ok && collect(parsed.value, tools, calls);
    });
  }
  if (!calls.length) {
    // The whole message is a JSON object (or a list of them) that names a tool.
    const bare = remaining.trim();
    if (/^[{[]/.test(bare)) {
      const parsed = parseJsonLoose(bare);
      if (parsed.ok && collect(parsed.value, tools, calls)) remaining = "";
    }
  }
  // The same call written twice (a tag and a fence) runs once.
  const seen = new Set<string>();
  const unique = calls.filter((call) => {
    const key = `${call.name}\u0000${call.arguments}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.forEach((call, i) => { if (call.id.startsWith("text-call-")) call.id = `text-call-${i + 1}`; });
  return { calls: unique, text: unique.length ? remaining.trim() : text };
}

const MARKERS = ["<tool_call", "<function=", "<function name", "[TOOL_CALLS]", "<|python_tag|>", "```tool_call", "```tool"];

/**
 * Sits between a model's stream and the screen. Ordinary text passes at once.
 * Text that begins to look like a tool call written as text (a marker, or a
 * message that opens with a JSON object) is held back instead, and handed
 * over at the end, where it is either read as calls or released as it was.
 */
export class ToolCallTextGuard {
  private held = "";
  private holding = false;
  private started = false;
  private first = true;
  /** Everything that has gone through, shown or not. */
  full = "";

  constructor(
    private readonly emit: (chunk: string) => void,
    private readonly enabled: boolean
  ) {}

  push(chunk: string): void {
    this.full += chunk;
    if (!this.enabled) { this.emit(chunk); return; }
    if (this.holding) { this.held += chunk; return; }
    this.held += chunk;
    let text = this.held;
    // A message that opens with `{` is held whole: it may be a call, and it is released at the end if it is not.
    if (!this.started) {
      const trimmed = text.replace(/^\s+/, "");
      if (trimmed.length > 0) {
        this.started = true;
        if (trimmed[0] === "{" || trimmed.startsWith("<|python_tag|>")) { this.holding = true; return; }
      } else {
        return;
      }
    }
    const markerAt = this.earliestMarker(text);
    if (markerAt >= 0) {
      if (markerAt > 0) this.emit(text.slice(0, markerAt));
      this.held = text.slice(markerAt);
      this.holding = true;
      return;
    }
    // Keep back a tail that might be the start of a marker.
    const keep = this.partialMarkerLength(text);
    const releasable = text.length - keep;
    if (releasable > 0) {
      this.emit(text.slice(0, releasable));
      this.held = text.slice(releasable);
    }
    void this.first;
  }

  private earliestMarker(text: string): number {
    let best = -1;
    for (const marker of MARKERS) {
      const at = text.indexOf(marker);
      if (at >= 0 && (best < 0 || at < best)) best = at;
    }
    return best;
  }

  private partialMarkerLength(text: string): number {
    let keep = 0;
    for (const marker of MARKERS) {
      const max = Math.min(marker.length - 1, text.length);
      for (let len = max; len > keep; len--) {
        if (text.endsWith(marker.slice(0, len))) { keep = len; break; }
      }
    }
    return keep;
  }

  /** What is being held, for the end of the stream. */
  get pending(): string {
    return this.held;
  }

  get isHolding(): boolean {
    return this.holding;
  }

  /** The stream is over and nothing in what was held was a call: it goes to the screen after all. */
  release(): void {
    if (this.held) {
      const text = this.held;
      this.held = "";
      this.holding = false;
      this.emit(text);
    }
  }

  /** The stream is over and what was held was read as calls: it is dropped, and what came before it was shown. */
  discardHeld(leftover = ""): void {
    this.held = "";
    this.holding = false;
    if (leftover) this.emit(leftover);
  }
}
