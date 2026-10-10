// ── harness/json-repair.ts ────────────────────────────────────────────────
// Models write JSON for tool arguments, and not every one writes it well: a
// trailing comma, a code fence around it, single quotes, a raw newline in a
// string, an answer cut off by the output limit, or the whole object encoded
// twice. A strict parse turns each of those into "the tool failed" and the
// model answers from nothing. This reads what can be read, says how much it
// had to fix, and refuses what it would have to invent.
// ─────────────────────────────────────────────────────────────────────────────

export type RepairKind = "none" | "cosmetic" | "truncated";

export type LooseParse =
  | { ok: true; value: unknown; repair: RepairKind }
  | { ok: false; error: string };

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

function stripFence(text: string): string {
  const m = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/.exec(text.trim());
  return m ? m[1].trim() : text;
}

/** The first balanced {...} or [...] in some prose around it. */
function firstBalanced(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Raw control characters inside strings (a newline typed into a "content" field) become escapes. */
function escapeControlsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') { inString = false; out += ch; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

function removeTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

/** 'single quoted' keys and values, when the text has no double-quoted string at all. */
function singleToDoubleQuotes(text: string): string | null {
  if (text.includes('"') || !text.includes("'")) return null;
  return text.replace(/'((?:[^'\\]|\\.)*)'/g, (_m, inner: string) => `"${inner.replace(/"/g, '\\"')}"`);
}

function pythonLiterals(text: string): string {
  return text.replace(/\bNone\b/g, "null").replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false");
}

/** Closes what an output limit left open, cutting back past a half-written value if it has to. */
function closeTruncated(text: string): string | null {
  const open = rebalance(text);
  if (open === text) return null;
  // Cut points: the end, then back over each comma and opener (a dangling key or a half-written value).
  const cuts = [text.length];
  for (let i = text.length - 1; i > 0 && cuts.length < 16; i--) {
    if (text[i] === ",") cuts.push(i);
    else if (text[i] === "{" || text[i] === "[") cuts.push(i + 1);
  }
  for (const cut of cuts) {
    const head = text.slice(0, cut).replace(/[\s,:]+$/, "");
    const plain = rebalance(head);
    if (tryParse(plain).ok) return plain;
    // `{"a": 1, "b"`: a key with no value is dropped.
    const withoutKey = rebalance(head.replace(/,\s*"(?:[^"\\]|\\.)*"\s*$/, "").replace(/\{\s*"(?:[^"\\]|\\.)*"\s*$/, "{"));
    if (tryParse(withoutKey).ok) return withoutKey;
  }
  return null;
}

/** Closes whatever is still open at the end of `text` (strings are expected to be closed already). */
function rebalance(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let out = text;
  if (inString) out += '"';
  return out + stack.reverse().join("");
}

/**
 * Reads tool arguments: strict first, then the cosmetic repairs, then (only if
 * the caller allows it) the repair of an answer that was cut off. An empty
 * string is an empty object, as models send it for tools with no arguments.
 */
export function parseJsonLoose(raw: string | null | undefined, opts: { allowTruncated?: boolean } = {}): LooseParse {
  const original = String(raw ?? "");
  const trimmed = original.trim();
  if (!trimmed) return { ok: true, value: {}, repair: "none" };

  const strict = tryParse(trimmed);
  if (strict.ok) {
    // A JSON string that holds JSON: arguments encoded twice.
    if (typeof strict.value === "string" && /^[\s]*[{[]/.test(strict.value)) {
      const inner = tryParse(strict.value);
      if (inner.ok) return { ok: true, value: inner.value, repair: "cosmetic" };
    }
    return { ok: true, value: strict.value, repair: "none" };
  }

  const candidates: string[] = [];
  const unfenced = stripFence(trimmed);
  candidates.push(unfenced);
  const balanced = firstBalanced(unfenced);
  if (balanced && balanced !== unfenced) candidates.push(balanced);

  for (const base of candidates) {
    const variants = [
      base,
      escapeControlsInStrings(base),
      removeTrailingCommas(escapeControlsInStrings(base)),
    ];
    const single = singleToDoubleQuotes(base);
    if (single) variants.push(removeTrailingCommas(escapeControlsInStrings(pythonLiterals(single))));
    variants.push(removeTrailingCommas(escapeControlsInStrings(pythonLiterals(base))));
    for (const variant of variants) {
      const parsed = tryParse(variant);
      if (parsed.ok) return { ok: true, value: parsed.value, repair: "cosmetic" };
    }
  }

  if (opts.allowTruncated) {
    const base = escapeControlsInStrings(stripFence(trimmed));
    const closed = closeTruncated(removeTrailingCommas(base));
    if (closed) {
      const parsed = tryParse(closed);
      if (parsed.ok) return { ok: true, value: parsed.value, repair: "truncated" };
    }
  }
  return { ok: false, error: strict.error };
}

/** Tool arguments are always an object; anything else is rejected with a reason the model can act on. */
export function parseToolArguments(raw: string | null | undefined, opts: { allowTruncated?: boolean } = {}):
  | { ok: true; args: Record<string, unknown>; repair: RepairKind }
  | { ok: false; error: string } {
  const parsed = parseJsonLoose(raw, opts);
  if (!parsed.ok) return { ok: false, error: `The arguments are not valid JSON (${parsed.error}).` };
  if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { ok: false, error: "The arguments must be a JSON object." };
  }
  return { ok: true, args: parsed.value as Record<string, unknown>, repair: parsed.repair };
}
