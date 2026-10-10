// ── harness/model-profile.ts ──────────────────────────────────────────────
// What a model can take in and give back, and which of the usual request
// parameters it will not accept. Nothing is capped by the plugin: the output
// limit and the context window are the model's own. They are found, in order
// of trust, from what the user set by hand, what a provider has said about
// itself (its model list, or an error that named the limit), what the
// provider's own API reported, a table of well-known models, and finally a
// default that is held loosely: the first error that names the real number
// replaces it and is remembered.
// ─────────────────────────────────────────────────────────────────────────────

import type { ModelMetadata } from "../provider-types";

export type ModelFamily =
  | "openai"
  | "openai-reasoning"
  | "anthropic"
  | "gemini"
  | "deepseek"
  | "qwen"
  | "llama"
  | "mistral"
  | "kimi"
  | "glm"
  | "grok"
  | "generic";

export type LimitSource = "override" | "learned" | "api" | "catalog" | "known" | "default";

export interface ModelProfile {
  providerId: string;
  providerType: string;
  model: string;
  family: ModelFamily;
  contextWindow: number;
  contextSource: LimitSource;
  /** The most a single answer may hold: what is sent as the output limit when the user has not set one. */
  maxOutput: number;
  outputSource: LimitSource;
  /** A model that thinks before it answers (its output limit has to leave room for that). */
  reasoning: boolean;
  acceptsTemperature: boolean;
  outputParam: "max_tokens" | "max_completion_tokens";
  /** Earlier thinking has to be sent back with the next request of the same turn. */
  passReasoningBack: boolean;
  nativeTools: boolean;
  vision: boolean;
  /** PDFs can be sent to this model as they are (the provider reads the pages itself). */
  pdfNative: boolean;
  /** The server understands `stream_options.include_usage`. */
  streamUsage: boolean;
  /** Ollama: the context length the server is asked to load. */
  numCtx?: number;
  /** What the model itself supports, where the window in use is smaller (a local server is asked for less). */
  modelMaxContext?: number;
}

/** Facts picked up while running, kept per model so the next request starts from them. */
export interface LearnedModelInfo {
  contextWindow?: number;
  contextSource?: "learned" | "api";
  maxOutput?: number;
  outputSource?: "learned" | "api";
  acceptsTemperature?: boolean;
  outputParam?: "max_tokens" | "max_completion_tokens";
  nativeTools?: boolean;
  streamUsage?: boolean;
  numCtx?: number;
  updatedAt: number;
}

export interface ProfileInput {
  providerId: string;
  providerType: string;
  baseUrl?: string;
  model: string;
  supportsVision?: boolean;
  catalog?: Pick<ModelMetadata, "contextLength" | "contextWindow" | "maxOutputTokens" | "capabilities"> | null;
  learned?: LearnedModelInfo | null;
  /** Set by hand in the model's settings. */
  override?: { contextWindow?: number; maxOutput?: number } | null;
  /**
   * Ollama allocates memory for the whole window it is asked for, so by default it is asked for at most this
   * much (32768). 0 means the model's own maximum.
   */
  localContextCap?: number;
}

interface KnownModel {
  match: RegExp;
  context: number;
  output: number;
  family: ModelFamily;
  reasoning?: boolean;
  /** Rejects `temperature` (and `top_p`) whatever its value. */
  noTemperature?: boolean;
  vision?: boolean;
}

/** More specific entries come first: the first match wins. Numbers are tokens. */
const KNOWN: KnownModel[] = [
  // OpenAI
  { match: /(^|[\/:])gpt-5(\.\d+)?-chat/, context: 128_000, output: 16_384, family: "openai", vision: true },
  { match: /(^|[\/:])gpt-5/, context: 400_000, output: 128_000, family: "openai-reasoning", reasoning: true, noTemperature: true, vision: true },
  { match: /(^|[\/:])o1-mini/, context: 128_000, output: 65_536, family: "openai-reasoning", reasoning: true, noTemperature: true },
  { match: /(^|[\/:])o1-preview/, context: 128_000, output: 32_768, family: "openai-reasoning", reasoning: true, noTemperature: true },
  { match: /(^|[\/:])o[134](-|$|\b)/, context: 200_000, output: 100_000, family: "openai-reasoning", reasoning: true, noTemperature: true, vision: true },
  { match: /(^|[\/:])gpt-4\.1/, context: 1_047_576, output: 32_768, family: "openai", vision: true },
  { match: /(^|[\/:])gpt-4o/, context: 128_000, output: 16_384, family: "openai", vision: true },
  { match: /(^|[\/:])gpt-4-turbo|(^|[\/:])gpt-4-1106|(^|[\/:])gpt-4-0125/, context: 128_000, output: 4_096, family: "openai", vision: true },
  { match: /(^|[\/:])gpt-4-32k/, context: 32_768, output: 4_096, family: "openai" },
  { match: /(^|[\/:])gpt-4(-|$)/, context: 8_192, output: 4_096, family: "openai" },
  { match: /(^|[\/:])gpt-3\.5/, context: 16_385, output: 4_096, family: "openai" },
  // Anthropic
  { match: /claude-3-5-haiku|claude-3\.5-haiku/, context: 200_000, output: 8_192, family: "anthropic", vision: true },
  { match: /claude-3-5-sonnet|claude-3\.5-sonnet/, context: 200_000, output: 8_192, family: "anthropic", vision: true },
  { match: /claude-3-7-sonnet|claude-3\.7-sonnet/, context: 200_000, output: 64_000, family: "anthropic", vision: true },
  { match: /claude-3-(haiku|sonnet|opus)/, context: 200_000, output: 4_096, family: "anthropic", vision: true },
  { match: /claude-opus-4-[01](\b|-)|claude-opus-4(-2025|$)|claude-4-opus/, context: 200_000, output: 32_000, family: "anthropic", vision: true },
  { match: /claude/, context: 200_000, output: 64_000, family: "anthropic", vision: true },
  // Google
  { match: /gemini-1\.5-pro/, context: 2_097_152, output: 8_192, family: "gemini", vision: true },
  { match: /gemini-1\.5/, context: 1_048_576, output: 8_192, family: "gemini", vision: true },
  { match: /gemini-2\.0/, context: 1_048_576, output: 8_192, family: "gemini", vision: true },
  { match: /gemini-(2\.5|3)/, context: 1_048_576, output: 65_536, family: "gemini", reasoning: true, vision: true },
  { match: /gemini/, context: 1_048_576, output: 8_192, family: "gemini", vision: true },
  { match: /gemma-?3n/, context: 32_768, output: 8_192, family: "gemini" },
  // Gemma 3 and everything after it reads 128k; only the first two generations were limited to 8k.
  { match: /gemma-?([3-9]|\d{2})(?!\d|b\b)/, context: 128_000, output: 8_192, family: "gemini", vision: true },
  // DeepSeek
  { match: /deepseek-reasoner|deepseek-r1|deepseek.*(think|reason)/, context: 128_000, output: 64_000, family: "deepseek", reasoning: true },
  { match: /deepseek/, context: 128_000, output: 8_192, family: "deepseek" },
  // Qwen
  { match: /qwq|qwen3.*(think|reason)/, context: 131_072, output: 32_768, family: "qwen", reasoning: true },
  { match: /qwen3/, context: 131_072, output: 16_384, family: "qwen" },
  { match: /qwen-?2\.5|qwen2/, context: 131_072, output: 8_192, family: "qwen" },
  { match: /qwen/, context: 32_768, output: 8_192, family: "qwen" },
  // Meta, Mistral, others
  { match: /llama-?3\.[123]|llama3\.[123]|llama-?4/, context: 131_072, output: 16_384, family: "llama" },
  { match: /llama-?3/, context: 8_192, output: 4_096, family: "llama" },
  { match: /llama/, context: 32_768, output: 8_192, family: "llama" },
  { match: /mistral-large|mistral-medium|magistral|pixtral-large/, context: 131_072, output: 16_384, family: "mistral" },
  { match: /codestral/, context: 256_000, output: 16_384, family: "mistral" },
  { match: /mistral|mixtral|ministral/, context: 32_768, output: 8_192, family: "mistral" },
  { match: /grok-4/, context: 256_000, output: 64_000, family: "grok", reasoning: true },
  { match: /grok/, context: 131_072, output: 32_768, family: "grok" },
  { match: /kimi|moonshot/, context: 131_072, output: 32_768, family: "kimi", reasoning: true },
  { match: /glm-?4|glm-?5|zai/, context: 128_000, output: 32_768, family: "glm", reasoning: true },
  { match: /phi-?[34]/, context: 128_000, output: 8_192, family: "generic" },
  { match: /gemma/, context: 8_192, output: 4_096, family: "generic" },
];

export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Asked for when nothing at all is known and a limit has to be sent (Anthropic always wants one). The first error that names the real maximum corrects it. */
export const DEFAULT_MAX_OUTPUT = 32_768;
/** Never plan for less room than this, whatever a bad number says. */
export const MIN_CONTEXT_WINDOW = 2_048;

function positive(n: unknown): number | undefined {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

export function resolveModelProfile(input: ProfileInput): ModelProfile {
  const id = input.model.toLowerCase();
  const known = KNOWN.find((entry) => entry.match.test(id));
  const learned = input.learned ?? undefined;
  const catalog = input.catalog ?? undefined;
  const override = input.override ?? undefined;

  let contextWindow = DEFAULT_CONTEXT_WINDOW;
  let contextSource: LimitSource = "default";
  const fromCatalog = positive(catalog?.contextWindow) ?? positive(catalog?.contextLength);
  if (known) { contextWindow = known.context; contextSource = "known"; }
  if (fromCatalog) { contextWindow = fromCatalog; contextSource = "catalog"; }
  if (learned?.contextWindow) { contextWindow = learned.contextWindow; contextSource = learned.contextSource ?? "learned"; }
  if (positive(override?.contextWindow)) { contextWindow = positive(override?.contextWindow)!; contextSource = "override"; }
  contextWindow = Math.max(MIN_CONTEXT_WINDOW, contextWindow);
  let numCtx = learned?.numCtx;
  let modelMaxContext: number | undefined;
  if (input.providerType === "ollama") {
    modelMaxContext = contextWindow;
    const cap = input.localContextCap === 0 ? Infinity : Math.max(MIN_CONTEXT_WINDOW, input.localContextCap ?? 32_768);
    // What was set by hand is taken as it is; otherwise the window is the smaller of the model's and the cap, and
    // never more than the last size the server managed to load.
    if (contextSource !== "override") contextWindow = Math.min(contextWindow, cap);
    if (numCtx && contextSource !== "override") contextWindow = Math.min(contextWindow, Math.max(MIN_CONTEXT_WINDOW, numCtx));
    numCtx = contextWindow;
  }

  let maxOutput = Math.min(DEFAULT_MAX_OUTPUT, Math.floor(contextWindow / 2));
  let outputSource: LimitSource = "default";
  const outputFromCatalog = positive(catalog?.maxOutputTokens);
  if (known) { maxOutput = known.output; outputSource = "known"; }
  if (outputFromCatalog) { maxOutput = outputFromCatalog; outputSource = "catalog"; }
  if (learned?.maxOutput) { maxOutput = learned.maxOutput; outputSource = learned.outputSource ?? "learned"; }
  if (positive(override?.maxOutput)) { maxOutput = positive(override?.maxOutput)!; outputSource = "override"; }
  // A local model has no output limit of its own, only the room left in the window it was loaded with.
  if (input.providerType === "ollama" && outputSource !== "override" && outputSource !== "learned") {
    maxOutput = Math.max(256, contextWindow - 1_024);
    outputSource = "known";
  }
  // An answer can never be longer than the window it has to fit in.
  maxOutput = Math.max(256, Math.min(maxOutput, Math.max(256, contextWindow - 1_024)));

  const family: ModelFamily = known?.family ?? "generic";
  const isOfficialOpenAI = input.providerType === "openai" || /(^|\.)api\.openai\.com/.test(input.baseUrl ?? "");
  const reasoning = Boolean(known?.reasoning || catalog?.capabilities?.reasoning);
  const acceptsTemperature = learned?.acceptsTemperature ?? !known?.noTemperature;
  const outputParam = learned?.outputParam ?? (isOfficialOpenAI || family === "openai-reasoning" ? "max_completion_tokens" : "max_tokens");
  const nativeTools = learned?.nativeTools ?? true;
  const vision = Boolean(input.supportsVision) || Boolean(known?.vision) || Boolean(catalog?.capabilities?.vision);
  const pdfNative =
    input.providerType === "anthropic" ||
    input.providerType === "gemini" ||
    input.providerType === "openrouter" ||
    (isOfficialOpenAI && Boolean(known?.vision));
  const passReasoningBack = input.providerType !== "openai" && input.providerType !== "anthropic" && input.providerType !== "gemini"
    && (family === "deepseek" || family === "kimi" || family === "glm" || (family === "qwen" && reasoning));

  return {
    providerId: input.providerId,
    providerType: input.providerType,
    model: input.model,
    family,
    contextWindow,
    contextSource,
    maxOutput,
    outputSource,
    reasoning,
    acceptsTemperature,
    outputParam,
    passReasoningBack,
    nativeTools,
    vision,
    pdfNative,
    streamUsage: learned?.streamUsage ?? input.providerType !== "cloudflare",
    numCtx,
    modelMaxContext,
  };
}

/** The limit to put on a request: the user's own, else the model's maximum. */
export function outputLimitFor(profile: ModelProfile, manual?: number): number {
  const wanted = positive(manual);
  if (wanted) return Math.min(wanted, profile.maxOutput);
  return profile.maxOutput;
}

// ── What error messages teach ─────────────────────────────────────────────

function numbers(text: string): number[] {
  const found: number[] = [];
  for (const m of text.matchAll(/\d[\d,_]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/[,_]/g, ""));
    if (Number.isFinite(n)) found.push(n);
  }
  return found;
}

/**
 * A request that did not fit, and the size of the window if the message says.
 * Providers word this a dozen ways; the ones below are the ones seen from
 * OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, Mistral, Groq, vLLM and
 * LM Studio, and anything else that talks about a context length.
 */
export function parseContextOverflow(message: string): { limit?: number; requested?: number; input?: number } | null {
  const text = String(message ?? "");
  // Phrases that are about the window itself. A message about a too-large `max_tokens` is not one of them.
  const looksLikeOverflow =
    /context[ _-]?(length|window|limit)|maximum context|prompt is too long|input (is )?too long|input token count .* exceeds|too many (input )?tokens|reduce the length of (the|your) (messages|prompt|input)|longer than the model|input length and .* exceed|request too large|exceeds? the (model'?s )?(token|context)/i.test(text);
  if (!looksLikeOverflow) return null;
  const patterns: RegExp[] = [
    /\d[\d,_]* ?\+ ?\d[\d,_]* ?> ?(\d[\d,_]*)/,
    /maximum context length (?:is|of) (\d[\d,_]*)/i,
    /maximum number of tokens allowed \((\d[\d,_]*)\)/i,
    /[>≥] ?(\d[\d,_]*) ?(?:maximum|max|tokens)/i,
    /(?:with|has) (\d[\d,_]*) maximum context length/i,
    /context (?:window|length|limit) (?:is|of|:) (\d[\d,_]*)/i,
    /(?:limit|maximum|max) (?:is|of|:) (\d[\d,_]*) tokens/i,
    /exceed(?:s|ed)? (?:the )?(?:limit|maximum|context)[^\d]{0,40}(\d[\d,_]*)/i,
  ];
  let limit: number | undefined;
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (m) {
      const n = Number(m[1].replace(/[,_]/g, ""));
      if (n >= MIN_CONTEXT_WINDOW) { limit = n; break; }
    }
  }
  // What the input alone came to, where the message splits it from the output limit.
  const inputMatch =
    /(\d[\d,_]*) ?\+ ?\d[\d,_]* ?>/.exec(text) ??
    /\((\d[\d,_]*) (?:in|of) (?:the )?(?:messages|text input|input|prompt)/i.exec(text);
  const input = inputMatch ? Number(inputMatch[1].replace(/[,_]/g, "")) : undefined;
  const requestedMatch = /(?:requested|resulted in|you requested about|prompt contains|input token count \(|prompt is too long: )\D{0,12}(\d[\d,_]*)/i.exec(text);
  const requested = requestedMatch ? Number(requestedMatch[1].replace(/[,_]/g, "")) : undefined;
  return { limit, requested, input };
}

/** An output limit that was too high, and the model's real maximum if the message gives it. */
export function parseOutputLimit(message: string, requested?: number): number | null {
  const text = String(message ?? "");
  if (!/max[_ ]?tokens|max[_ ]?completion[_ ]?tokens|maxOutputTokens|output tokens|completion tokens|max_output/i.test(text)) return null;
  if (!/(too large|too high|exceed|greater than|larger than|must be|maximum|supports? at most|valid range|supported range|invalid|<=|less than|not exceed|limit)/i.test(text)) return null;
  // "supported range is from 1 (inclusive) to 8193 (exclusive)".
  const exclusive = /to (\d[\d,_]*) \(exclusive\)/i.exec(text);
  if (exclusive) return Number(exclusive[1].replace(/[,_]/g, "")) - 1;
  const named = [
    /(?:at most|up to|maximum(?: allowed)?(?: number)? (?:of )?(?:output |completion )?tokens? (?:is|of|:)?|maximum allowed number of output tokens[^\d]{0,30}|<=|less than or equal to|valid range of [a-z_]+ is \[\d+, ?)\s*(\d[\d,_]*)/i,
    /max_?(?:completion_?)?tokens[^\d]{0,40}(?:must be|should be|is limited to|is capped at)[^\d]{0,15}(\d[\d,_]*)/i,
  ];
  for (const pattern of named) {
    const m = pattern.exec(text);
    if (m) {
      const n = Number(m[1].replace(/[,_]/g, ""));
      if (n >= 256 && (!requested || n < requested)) return n;
    }
  }
  // Anthropic: "max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens".
  const candidates = numbers(text).filter((n) => n >= 256 && (!requested || n < requested));
  if (!candidates.length) return null;
  return Math.max(...candidates);
}

export type UnsupportedParam = "temperature" | "max_tokens" | "max_completion_tokens" | "stream_options" | "tools" | "top_p" | "other";

/** A parameter the server refused, so the request can be sent again without it. */
export function parseUnsupportedParam(message: string): UnsupportedParam | null {
  const text = String(message ?? "");
  if (/does not support (tools|function|tool)|tools? (is|are) not supported|tool use is not supported|function calling is not supported|doesn'?t support tools|no endpoints found that support tool|not support(ed)? .*tool[_ ]?(choice|calls?)/i.test(text)) return "tools";
  if (/stream_options|include_usage/i.test(text) && /(unknown|unrecognized|unsupported|not (supported|allowed)|extra|invalid)/i.test(text)) return "stream_options";
  // Which of the two names for the output limit was refused: the one the message calls unsupported.
  const refusedOutput =
    /['"`]?(max_completion_tokens|max_tokens)['"`]? (?:is|are) not supported/i.exec(text) ??
    /(?:unsupported|unknown|unrecognized|invalid)[^.\n]{0,40}?['"`]?(max_completion_tokens|max_tokens)\b/i.exec(text);
  if (refusedOutput && !/too large|too high|exceed|must be (<=|less)/i.test(text)) {
    return refusedOutput[1].toLowerCase() === "max_tokens" ? "max_tokens" : "max_completion_tokens";
  }
  if (/temperature/i.test(text) && /(unsupported|not support|only the default|does not support|deprecated|cannot|can't|must be|isn't supported)/i.test(text)) return "temperature";
  if (/top_p/i.test(text) && /(unsupported|not support|only the default|deprecated)/i.test(text)) return "top_p";
  return null;
}
