import { ProviderConfig } from "./settings";
import { fetchCloudflareModels, fetchCloudflareModelSchema, cloudflareApiBase, cloudflareHeaders, normalizeCloudflareModelId } from "./cloudflare";
import { requestUrl } from "obsidian";
import { streamEvents, WireOptions, FIRST_BYTE_TIMEOUT_MS, REASONING_FIRST_BYTE_TIMEOUT_MS } from "./harness/wire";
import { ProviderError } from "./harness/errors";
import { ModelProfile, outputLimitFor, resolveModelProfile } from "./harness/model-profile";
import type { TokenUsage } from "./harness/tokens";
import type { MessagePart } from "./provider-types";

export interface ProviderRuntimeOptions {
  /** A limit on one answer set by the user. Unset means the model's own maximum. */
  maxTokens?: number;
  temperature?: number;
  modelOptions?: Record<string, string | number | boolean>;
  /** What is known about the model: its limits and which parameters it takes. Worked out from the config when not given. */
  profile?: ModelProfile;
}

/** Options for one request, which the loop adjusts between attempts. */
export interface ChatOptions {
  /** The output limit for this request (the model's maximum, or what is left of its window). */
  maxOutput?: number;
  /** Closing it closes the connection. */
  signal?: AbortSignal;
}

// Unified message + tool types used across all providers.
export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string;
  parts?: MessagePart[];
  metadata?: Record<string, unknown>;
  /** For tool-result messages */
  tool_call_id?: string;
  /** Original function name for providers such as Gemini. */
  tool_name?: string;
  /** For assistant tool calls */
  tool_calls?: ToolCall[];
  /** What a thinking model thought before this answer, kept for the providers that want it back within a turn. */
  reasoning?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
  /** Provider-specific data that has to travel with the call (Gemini's thought signature). */
  extra?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: object; // JSON schema
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "malformed" | "other";

export interface FinishInfo {
  reason: FinishReason;
  /** The provider's own word for it. */
  raw?: string;
}

export interface StreamCallbacks {
  onToken: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  onToolCalls?: (calls: ToolCall[]) => void;
  /** What the provider counted for this request. */
  onUsage?: (usage: TokenUsage) => void;
  /** Why the answer ended. */
  onFinish?: (info: FinishInfo) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

/**
 * Base class for provider adapters. Each adapter normalizes a provider's
 * API into the unified ChatMessage / ToolDefinition interface and supports
 * streaming responses with native (provider-side) tool use where available.
 */
export abstract class BaseProvider {
  protected config: ProviderConfig;
  protected runtime: ProviderRuntimeOptions;
  protected profile: ModelProfile;

  constructor(config: ProviderConfig, runtime: ProviderRuntimeOptions = {}) {
    this.config = config;
    this.runtime = runtime;
    this.profile =
      runtime.profile ??
      resolveModelProfile({
        providerId: config.id,
        providerType: config.type,
        baseUrl: config.baseUrl,
        model: config.model,
        supportsVision: config.supportsVision,
      });
  }

  abstract chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    cb: StreamCallbacks,
    options?: ChatOptions
  ): Promise<void>;

  protected getHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...extra,
    };
    if (this.config.extraHeaders) {
      try {
        const parsed = JSON.parse(this.config.extraHeaders);
        Object.assign(headers, parsed);
      } catch {
        /* ignore malformed extra headers */
      }
    }
    return headers;
  }

  /** The limit on this answer: set by the loop for the request, else the user's, else the model's own maximum. */
  protected maxOutput(options?: ChatOptions): number {
    return options?.maxOutput ?? outputLimitFor(this.profile, this.runtime.maxTokens);
  }

  /** Model options the user set, minus the ones this class decides itself. */
  protected extraModelOptions(): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(this.runtime.modelOptions ?? {})) {
      if (key === "max_tokens" || key === "max_completion_tokens" || key === "maxOutputTokens") continue;
      out[key] = value;
    }
    return out;
  }

  protected wire(options?: ChatOptions, extra: Partial<WireOptions> = {}): WireOptions {
    return {
      signal: options?.signal,
      firstByteTimeoutMs: this.profile.reasoning ? REASONING_FIRST_BYTE_TIMEOUT_MS : FIRST_BYTE_TIMEOUT_MS,
      ...extra,
    };
  }

  protected streamLines(
    body: string,
    url: string,
    headers: Record<string, string>,
    options?: ChatOptions,
    extra: Partial<WireOptions> = {}
  ): AsyncGenerator<string> {
    return streamEvents(url, headers, body, this.wire(options, extra));
  }
}

function normalizedOpenAIContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return JSON.stringify(part);
    }).filter(Boolean).join("\n");
  }
  return typeof content === "object" ? JSON.stringify(content) : String(content);
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

/** Images and PDFs a message carries that this model can take as they are. */
function mediaOf(message: ChatMessage, profile: ModelProfile): MessagePart[] {
  return (message.parts ?? []).filter(
    (part) => part.data && ((part.type === "image" && profile.vision) || (part.type === "pdf" && profile.pdfNative))
  );
}

function dataUri(part: MessagePart): string {
  return `data:${part.mimeType ?? (part.type === "pdf" ? "application/pdf" : "image/png")};base64,${part.data}`;
}

/** A stream that ended without saying it was finished was cut off (a dropped connection, a crashed server). */
function incompleteStream(): ProviderError {
  const error = new ProviderError("Provider error: the stream ended before the answer was complete.", { code: "ECONNRESET" });
  error.midStream = true;
  return error;
}

function toolCallsArgs(args: unknown): string {
  if (typeof args === "string") return args;
  try { return JSON.stringify(args ?? {}); } catch { return "{}"; }
}

// ── OpenAI and everything that speaks its protocol ────────────────────────

/** The index of the last real user message: reasoning from before it is not sent back. */
function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && typeof messages[i].metadata?.kind !== "string") return i;
  }
  return -1;
}

export function buildOpenAIMessages(messages: ChatMessage[], profile: ModelProfile): any[] {
  const turnStart = lastUserIndex(messages);
  return messages.map((m, index) => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      const out: any = {
        role: "assistant",
        content: normalizedOpenAIContent(m.content),
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: toolCallsArgs(tc.arguments) },
        })),
      };
      if (profile.passReasoningBack && m.reasoning && index > turnStart) out.reasoning_content = m.reasoning;
      return out;
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.tool_call_id, content: normalizedOpenAIContent(m.content) };
    }
    if (m.role === "user") {
      const media = mediaOf(m, profile);
      if (media.length) {
        const content: any[] = [];
        const text = normalizedOpenAIContent(m.content);
        if (text) content.push({ type: "text", text });
        for (const part of media) {
          if (part.type === "image") content.push({ type: "image_url", image_url: { url: dataUri(part) } });
          else content.push({ type: "file", file: { filename: part.name ?? "document.pdf", file_data: dataUri(part) } });
        }
        return { role: "user", content };
      }
    }
    return { role: m.role, content: normalizedOpenAIContent(m.content) };
  });
}

export function buildOpenAIPayload(args: {
  config: ProviderConfig;
  profile: ModelProfile;
  runtime: ProviderRuntimeOptions;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxOutput: number;
}): any {
  const { config, profile, runtime, messages, tools, maxOutput } = args;
  const payload: any = {
    model: config.model,
    messages: buildOpenAIMessages(messages, profile),
    stream: true,
  };
  if (profile.streamUsage) payload.stream_options = { include_usage: true };
  if (runtime.temperature !== undefined && profile.acceptsTemperature) payload.temperature = runtime.temperature;
  payload[profile.outputParam] = maxOutput;
  for (const [key, value] of Object.entries(runtime.modelOptions ?? {})) {
    if (key === "max_tokens" || key === "max_completion_tokens") continue;
    if (key === "temperature" && !profile.acceptsTemperature) continue;
    payload[key] = value;
  }
  if (tools.length && profile.nativeTools) {
    payload.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    payload.tool_choice = "auto";
  }
  return payload;
}

/** An OpenAI `finish_reason`, in the harness's words. */
function openAIFinish(raw: string | null | undefined, hadToolCalls: boolean): FinishInfo {
  // An answer cut off by the output limit is that, calls or not: the last call may be half written.
  if (raw === "length") return { reason: "length", raw };
  if (hadToolCalls) return { reason: "tool_calls", raw: raw ?? undefined };
  switch (raw) {
    case "length": return { reason: "length", raw };
    case "content_filter": return { reason: "content_filter", raw };
    case "stop":
    case "end_turn":
    case null:
    case undefined: return { reason: "stop", raw: raw ?? undefined };
    case "tool_calls":
    case "function_call": return { reason: "tool_calls", raw };
    default: return { reason: "other", raw };
  }
}

/**
 * OpenAI and OpenAI-compatible endpoints (DeepSeek, Qwen, OpenRouter, vLLM, etc.)
 * This adapter also covers the generic "custom" type when it speaks the
 * OpenAI chat/completions protocol.
 */
export class OpenAIProvider extends BaseProvider {
  chat(messages: ChatMessage[], tools: ToolDefinition[], cb: StreamCallbacks, options?: ChatOptions): Promise<void> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const headers = this.getHeaders({ Authorization: `Bearer ${this.config.apiKey}` });
    const payload = buildOpenAIPayload({
      config: this.config,
      profile: this.profile,
      runtime: this.runtime,
      messages,
      tools,
      maxOutput: this.maxOutput(options),
    });
    return this.runStream(url, headers, payload, cb, options);
  }

  private async runStream(
    url: string,
    headers: Record<string, string>,
    payload: any,
    cb: StreamCallbacks,
    options?: ChatOptions
  ): Promise<void> {
    try {
      // One entry per call, in the order the model began them. Servers differ in how they number and identify the
      // pieces: by index, by id, or neither, and some send a whole call at once.
      const slots: Array<{ id: string; name: string; args: string }> = [];
      const byIndex = new Map<number, number>();
      let finishRaw: string | null | undefined;
      let sawDone = false;
      for await (const data of this.streamLines(JSON.stringify(payload), url, headers, options)) {
        if (data === "[DONE]") { sawDone = true; continue; }
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.error) {
          const err = json.error;
          const message = typeof err === "string" ? err : err.message ?? JSON.stringify(err);
          const status = typeof err?.code === "number" ? err.code : typeof err?.status === "number" ? err.status : undefined;
          const error = new ProviderError(`Provider error${status ? ` (${status})` : ""}: ${String(message).slice(0, 800)}`, { status, body: JSON.stringify(err) });
          error.midStream = true;
          throw error;
        }
        if (json.usage && typeof json.usage === "object") {
          const u = json.usage;
          cb.onUsage?.({
            inputTokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0),
            outputTokens: Number(u.completion_tokens ?? u.output_tokens ?? 0),
            cachedTokens: Number(u.prompt_tokens_details?.cached_tokens ?? 0) || undefined,
            reasoningTokens: Number(u.completion_tokens_details?.reasoning_tokens ?? 0) || undefined,
          });
        }
        const choice = json.choices?.[0];
        if (choice?.finish_reason) finishRaw = choice.finish_reason;
        const delta = choice?.delta;
        if (!delta) continue;
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking ?? json.reasoning;
        if (typeof reasoning === "string" && reasoning) cb.onReasoning?.(reasoning);
        const text = normalizedOpenAIContent(delta.content);
        if (text) cb.onToken(text);
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const id = typeof tc.id === "string" && tc.id ? tc.id : "";
            let slot = -1;
            if (id) slot = slots.findIndex((s) => s.id === id);
            if (slot < 0 && tc.index !== undefined && byIndex.has(tc.index)) {
              const candidate = byIndex.get(tc.index)!;
              // The same index with a different id is a different call.
              if (!id || !slots[candidate].id || slots[candidate].id === id) slot = candidate;
            }
            if (slot < 0) {
              slots.push({ id, name: "", args: "" });
              slot = slots.length - 1;
            }
            if (tc.index !== undefined) byIndex.set(tc.index, slot);
            const current = slots[slot];
            if (id && !current.id) current.id = id;
            if (tc.function?.name && !current.name) current.name = tc.function.name;
            else if (tc.function?.name && current.name !== tc.function.name && !current.args) current.name = tc.function.name;
            const args = tc.function?.arguments;
            if (typeof args === "string") current.args += args;
            else if (args && typeof args === "object") current.args = JSON.stringify(args);
          }
        }
      }
      if (!finishRaw && !sawDone) throw incompleteStream();
      const calls: ToolCall[] = slots
        .filter((s) => s.name)
        .map((s, i) => ({ id: s.id || `call_${i + 1}`, name: s.name, arguments: s.args }));
      if (calls.length) cb.onToolCalls?.(calls);
      cb.onFinish?.(openAIFinish(finishRaw, calls.length > 0));
      cb.onDone();
    } catch (e) {
      cb.onError(e as Error);
    }
  }
}

// ── Anthropic ─────────────────────────────────────────────────────────────

type AnthropicBlock = Record<string, any>;
interface AnthropicTurn { role: "user" | "assistant"; content: AnthropicBlock[] }

export function buildAnthropicTurns(messages: ChatMessage[], profile: ModelProfile): AnthropicTurn[] {
  const turns: AnthropicTurn[] = [];
  const push = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    if (!blocks.length) return;
    const last = turns[turns.length - 1];
    // Consecutive turns of one role are one turn. Tool results must come first in a user turn.
    if (last && last.role === role) {
      if (role === "user") {
        const results = blocks.filter((b) => b.type === "tool_result");
        const rest = blocks.filter((b) => b.type !== "tool_result");
        const lastResults = last.content.filter((b) => b.type === "tool_result");
        const lastRest = last.content.filter((b) => b.type !== "tool_result");
        last.content = [...lastResults, ...results, ...lastRest, ...rest];
      } else {
        last.content.push(...blocks);
      }
      return;
    }
    turns.push({ role, content: blocks });
  };

  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") continue;
    if (m.role === "user") {
      const blocks: AnthropicBlock[] = [];
      for (const part of mediaOf(m, profile)) {
        if (part.type === "image") blocks.push({ type: "image", source: { type: "base64", media_type: part.mimeType ?? "image/png", data: part.data } });
        else blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: part.data }, title: part.name });
      }
      if (m.content?.trim()) blocks.push({ type: "text", text: m.content });
      push("user", blocks);
    } else if (m.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      if (m.content?.trim()) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: safeParse(toolCallsArgs(tc.arguments)) });
      }
      push("assistant", blocks);
    } else if (m.role === "tool") {
      const block: AnthropicBlock = {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: m.content?.length ? m.content : "(the tool returned nothing)",
      };
      if (/^Tool error:/.test(m.content ?? "")) block.is_error = true;
      push("user", [block]);
    }
  }
  return turns;
}

export function buildAnthropicPayload(args: {
  config: ProviderConfig;
  profile: ModelProfile;
  runtime: ProviderRuntimeOptions;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxOutput: number;
}): any {
  const { config, profile, runtime, messages, tools, maxOutput } = args;
  const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const turns = buildAnthropicTurns(messages, profile);
  // Prompt caching: the system prompt, and everything up to the end of the latest turn, is read from the cache by
  // the next request of a tool loop. Only the first-party endpoint is known to take the field.
  const cache = /anthropic\.com/.test(config.baseUrl);
  if (cache && turns.length) {
    const lastBlocks = turns[turns.length - 1].content;
    lastBlocks[lastBlocks.length - 1] = { ...lastBlocks[lastBlocks.length - 1], cache_control: { type: "ephemeral" } };
  }
  const payload: any = {
    model: config.model,
    max_tokens: maxOutput,
    messages: turns,
    stream: true,
  };
  if (sys) payload.system = cache ? [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }] : sys;
  if (runtime.temperature !== undefined && profile.acceptsTemperature) payload.temperature = Math.max(0, Math.min(1, runtime.temperature));
  if (tools.length && profile.nativeTools) {
    payload.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  return payload;
}

function anthropicFinish(raw: string | undefined, hadToolCalls: boolean): FinishInfo {
  if (raw === "max_tokens") return { reason: "length", raw };
  if (hadToolCalls) return { reason: "tool_calls", raw };
  switch (raw) {
    case "max_tokens": return { reason: "length", raw };
    case "refusal": return { reason: "content_filter", raw };
    case "tool_use": return { reason: "tool_calls", raw };
    case "end_turn":
    case "stop_sequence":
    case undefined: return { reason: "stop", raw };
    default: return { reason: "other", raw };
  }
}

/**
 * Anthropic Messages API adapter. Tool use is native.
 */
export class AnthropicProvider extends BaseProvider {
  chat(messages: ChatMessage[], tools: ToolDefinition[], cb: StreamCallbacks, options?: ChatOptions): Promise<void> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/messages`;
    const headers = this.getHeaders({
      "x-api-key": this.config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    });
    const payload = buildAnthropicPayload({
      config: this.config,
      profile: this.profile,
      runtime: this.runtime,
      messages,
      tools,
      maxOutput: this.maxOutput(options),
    });
    return this.runStream(url, headers, payload, cb, options);
  }

  private async runStream(
    url: string,
    headers: Record<string, string>,
    payload: any,
    cb: StreamCallbacks,
    options?: ChatOptions
  ): Promise<void> {
    try {
      const blocks = new Map<number, { id: string; name: string; args: string }>();
      let inputTokens = 0;
      let cached = 0;
      let outputTokens = 0;
      let stopReason: string | undefined;
      let stopped = false;
      for await (const data of this.streamLines(JSON.stringify(payload), url, headers, options)) {
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        switch (json.type) {
          case "message_stop":
            stopped = true;
            break;
          case "error": {
            const err = json.error ?? {};
            const status = err.type === "overloaded_error" ? 529 : err.type === "rate_limit_error" ? 429 : err.type === "api_error" ? 500 : undefined;
            const error = new ProviderError(`Provider error${status ? ` (${status})` : ""}: ${String(err.message ?? JSON.stringify(err)).slice(0, 800)}`, { status, body: JSON.stringify(err) });
            error.midStream = true;
            throw error;
          }
          case "message_start": {
            const u = json.message?.usage ?? {};
            cached = Number(u.cache_read_input_tokens ?? 0);
            inputTokens = Number(u.input_tokens ?? 0) + cached + Number(u.cache_creation_input_tokens ?? 0);
            outputTokens = Number(u.output_tokens ?? 0);
            break;
          }
          case "message_delta":
            if (json.delta?.stop_reason) stopReason = json.delta.stop_reason;
            if (json.usage?.output_tokens !== undefined) outputTokens = Number(json.usage.output_tokens);
            if (json.usage?.input_tokens !== undefined && Number(json.usage.input_tokens) > 0) {
              inputTokens = Number(json.usage.input_tokens) + Number(json.usage.cache_read_input_tokens ?? cached) + Number(json.usage.cache_creation_input_tokens ?? 0);
            }
            break;
          case "content_block_start":
            if (json.content_block?.type === "tool_use") {
              blocks.set(json.index ?? blocks.size, { id: json.content_block.id, name: json.content_block.name, args: "" });
              const initial = json.content_block.input;
              if (initial && typeof initial === "object" && Object.keys(initial).length) blocks.get(json.index ?? blocks.size - 1)!.args = JSON.stringify(initial);
            }
            break;
          case "content_block_delta":
            if (json.delta?.type === "text_delta") {
              cb.onToken(json.delta.text);
            } else if (json.delta?.type === "thinking_delta") {
              if (json.delta.thinking) cb.onReasoning?.(json.delta.thinking);
            } else if (json.delta?.type === "input_json_delta") {
              const block = blocks.get(json.index ?? 0);
              if (block) block.args += json.delta.partial_json ?? "";
            }
            break;
        }
      }
      if (!stopped && !stopReason) throw incompleteStream();
      const calls: ToolCall[] = Array.from(blocks.values())
        .filter((b) => b.name)
        .map((b) => ({ id: b.id, name: b.name, arguments: b.args }));
      if (calls.length) cb.onToolCalls?.(calls);
      if (inputTokens || outputTokens) cb.onUsage?.({ inputTokens, outputTokens, cachedTokens: cached || undefined });
      cb.onFinish?.(anthropicFinish(stopReason, calls.length > 0));
      cb.onDone();
    } catch (e) {
      cb.onError(e as Error);
    }
  }
}

// ── Google Gemini ─────────────────────────────────────────────────────────

const GEMINI_DROPPED_KEYS = new Set(["additionalProperties", "$schema", "$id", "$ref", "$defs", "definitions", "default", "examples", "title", "const", "patternProperties", "minLength", "maxLength", "pattern", "format", "multipleOf", "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems", "uniqueItems", "oneOf", "allOf"]);

/** Gemini takes a subset of JSON Schema and answers any other keyword with a 400. */
export function geminiSchema(node: any): any {
  if (Array.isArray(node)) return node.map(geminiSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(node)) {
    if (GEMINI_DROPPED_KEYS.has(key)) continue;
    if (key === "type" && Array.isArray(value)) {
      const types = (value as string[]).filter((t) => t !== "null");
      out.type = types[0] ?? "string";
      if (types.length !== (value as string[]).length) out.nullable = true;
      continue;
    }
    if (key === "enum" && Array.isArray(value)) { out.enum = value.map((v) => String(v)); continue; }
    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(Object.entries(value as Record<string, any>).map(([k, v]) => [k, geminiSchema(v)]));
      continue;
    }
    out[key] = key === "items" || key === "anyOf" ? geminiSchema(value) : value;
  }
  if (typeof out.type === "string") out.type = out.type.toLowerCase();
  return out;
}

type GeminiPart = Record<string, any>;
interface GeminiContent { role: "user" | "model"; parts: GeminiPart[] }

export function buildGeminiContents(messages: ChatMessage[], profile: ModelProfile): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const push = (role: "user" | "model", parts: GeminiPart[]) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") continue;
    if (m.role === "user") {
      const parts: GeminiPart[] = [];
      for (const part of m.parts ?? []) {
        if (!part.data) continue;
        if ((part.type === "image" && profile.vision) || part.type === "pdf" || part.type === "audio") {
          parts.push({ inlineData: { mimeType: part.mimeType ?? (part.type === "pdf" ? "application/pdf" : part.type === "audio" ? "audio/mpeg" : "image/png"), data: part.data } });
        }
      }
      if (m.content?.trim()) parts.push({ text: m.content });
      push("user", parts);
    } else if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (m.content?.trim()) parts.push({ text: m.content });
      for (const tc of m.tool_calls ?? []) {
        const part: GeminiPart = { functionCall: { name: tc.name, args: safeParse(toolCallsArgs(tc.arguments)) } };
        if (tc.extra?.thoughtSignature) part.thoughtSignature = tc.extra.thoughtSignature;
        parts.push(part);
      }
      push("model", parts);
    } else if (m.role === "tool") {
      // All the results of one round go in one turn, one part per call, in the order the calls were made.
      push("user", [{ functionResponse: { name: m.tool_name ?? m.tool_call_id ?? "tool", response: { result: m.content ?? "" } } }]);
    }
  }
  return contents;
}

export function buildGeminiPayload(args: {
  profile: ModelProfile;
  runtime: ProviderRuntimeOptions;
  config: ProviderConfig;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxOutput: number;
}): any {
  const { profile, runtime, config, messages, tools, maxOutput } = args;
  const systemInstruction = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const generationConfig: any = { maxOutputTokens: maxOutput };
  if (runtime.temperature !== undefined && profile.acceptsTemperature) generationConfig.temperature = Math.max(0, Math.min(2, runtime.temperature));
  const payload: any = {
    contents: buildGeminiContents(messages, profile),
    generationConfig,
  };
  if (systemInstruction) payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  const geminiTools: any[] = [];
  if (tools.length && profile.nativeTools) {
    geminiTools.push({
      functionDeclarations: tools.map((t) => {
        const parameters = geminiSchema(t.parameters);
        const hasProps = parameters && typeof parameters === "object" && parameters.properties && Object.keys(parameters.properties).length > 0;
        return hasProps
          ? { name: t.name, description: t.description, parameters }
          : { name: t.name, description: t.description };
      }),
    });
  } else if (config.supportsWebSearch) {
    // Search grounding cannot be combined with function declarations on most Gemini models; the agent has its own web_search tool.
    geminiTools.push({ googleSearch: {} });
  }
  if (geminiTools.length) payload.tools = geminiTools;
  return payload;
}

function geminiFinish(raw: string | undefined, hadToolCalls: boolean): FinishInfo {
  if (raw === "MAX_TOKENS") return { reason: "length", raw };
  if (hadToolCalls) return { reason: "tool_calls", raw };
  switch (raw) {
    case "MAX_TOKENS": return { reason: "length", raw };
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII": return { reason: "content_filter", raw };
    case "MALFORMED_FUNCTION_CALL": return { reason: "malformed", raw };
    case "STOP":
    case undefined: return { reason: "stop", raw };
    default: return { reason: "other", raw };
  }
}

/**
 * Google Gemini adapter (generativelanguage API). Tool use + web search supported.
 */
export class GeminiProvider extends BaseProvider {
  chat(messages: ChatMessage[], tools: ToolDefinition[], cb: StreamCallbacks, options?: ChatOptions): Promise<void> {
    // Gemini path: baseUrl/models/{model}:streamGenerateContent?alt=sse, the key in a header (a key in the URL ends up in logs and error messages).
    const model = this.config.model.replace(/^models\//, "");
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/models/${model}:streamGenerateContent?alt=sse`;
    const payload = buildGeminiPayload({
      profile: this.profile,
      runtime: this.runtime,
      config: this.config,
      messages,
      tools,
      maxOutput: this.maxOutput(options),
    });
    return this.runStream(url, this.getHeaders({ "x-goog-api-key": this.config.apiKey }), payload, cb, options);
  }

  private async runStream(
    url: string,
    headers: Record<string, string>,
    payload: any,
    cb: StreamCallbacks,
    options?: ChatOptions
  ): Promise<void> {
    try {
      const calls: ToolCall[] = [];
      let finishRaw: string | undefined;
      let usage: any;
      for await (const data of this.streamLines(JSON.stringify(payload), url, headers, options)) {
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.error) {
          const err = json.error;
          const status = typeof err.code === "number" ? err.code : undefined;
          const error = new ProviderError(`Provider error${status ? ` (${status})` : ""}: ${String(err.message ?? JSON.stringify(err)).slice(0, 800)}`, { status, body: JSON.stringify(err) });
          error.midStream = true;
          throw error;
        }
        if (json.promptFeedback?.blockReason) {
          throw new ProviderError(`Provider error (400): The prompt was blocked (${json.promptFeedback.blockReason}).`, { status: 400, body: JSON.stringify(json.promptFeedback) });
        }
        if (json.usageMetadata) usage = json.usageMetadata;
        const candidate = json.candidates?.[0];
        if (candidate?.finishReason) finishRaw = candidate.finishReason;
        for (const part of candidate?.content?.parts ?? []) {
          if (part.functionCall) {
            const call: ToolCall = {
              id: `gemini-call-${calls.length + 1}`,
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            };
            if (part.thoughtSignature) call.extra = { thoughtSignature: part.thoughtSignature };
            calls.push(call);
          } else if (typeof part.text === "string" && part.text) {
            if (part.thought === true) cb.onReasoning?.(part.text);
            else cb.onToken(part.text);
          }
        }
      }
      if (!finishRaw) throw incompleteStream();
      if (calls.length) cb.onToolCalls?.(calls);
      if (usage) {
        cb.onUsage?.({
          inputTokens: Number(usage.promptTokenCount ?? 0),
          outputTokens: Number(usage.candidatesTokenCount ?? 0) + Number(usage.thoughtsTokenCount ?? 0),
          cachedTokens: Number(usage.cachedContentTokenCount ?? 0) || undefined,
          reasoningTokens: Number(usage.thoughtsTokenCount ?? 0) || undefined,
        });
      }
      cb.onFinish?.(geminiFinish(finishRaw, calls.length > 0));
      cb.onDone();
    } catch (e) {
      cb.onError(e as Error);
    }
  }
}

// ── Ollama, spoken natively ───────────────────────────────────────────────
// The OpenAI-compatible endpoint Ollama offers has no way to say how long the
// context should be, and Ollama's own default is a few thousand tokens: a
// long conversation (or just the tool definitions) is cut from the front
// without a word, and the model carries on without its instructions. The
// native endpoint takes `num_ctx`.

export function ollamaOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/(v1|api)$/, "");
}

export function buildOllamaPayload(args: {
  config: ProviderConfig;
  profile: ModelProfile;
  runtime: ProviderRuntimeOptions;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxOutput: number;
}): any {
  const { config, profile, runtime, messages, tools, maxOutput } = args;
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      out.push({
        role: "assistant",
        content: m.content ?? "",
        tool_calls: m.tool_calls.map((tc) => ({ function: { name: tc.name, arguments: safeParse(toolCallsArgs(tc.arguments)) } })),
      });
    } else if (m.role === "tool") {
      out.push({ role: "tool", content: m.content ?? "", tool_name: m.tool_name });
    } else if (m.role === "user") {
      const images = (m.parts ?? []).filter((p) => p.type === "image" && p.data && profile.vision).map((p) => p.data);
      out.push(images.length ? { role: "user", content: m.content ?? "", images } : { role: "user", content: m.content ?? "" });
    } else {
      out.push({ role: m.role === "developer" ? "system" : m.role, content: m.content ?? "" });
    }
  }
  const options: Record<string, any> = {
    num_ctx: profile.numCtx ?? profile.contextWindow,
    num_predict: maxOutput,
  };
  if (runtime.temperature !== undefined && profile.acceptsTemperature) options.temperature = runtime.temperature;
  for (const [key, value] of Object.entries(runtime.modelOptions ?? {})) {
    if (key === "max_tokens" || key === "max_completion_tokens" || key === "temperature") continue;
    options[key === "repetition_penalty" ? "repeat_penalty" : key] = value;
  }
  const payload: any = { model: config.model, messages: out, stream: true, options };
  if (tools.length && profile.nativeTools) {
    payload.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  return payload;
}

export class OllamaProvider extends BaseProvider {
  async chat(messages: ChatMessage[], tools: ToolDefinition[], cb: StreamCallbacks, options?: ChatOptions): Promise<void> {
    const url = `${ollamaOrigin(this.config.baseUrl)}/api/chat`;
    const payload = buildOllamaPayload({
      config: this.config,
      profile: this.profile,
      runtime: this.runtime,
      messages,
      tools,
      maxOutput: this.maxOutput(options),
    });
    let emitted = false;
    try {
      const calls: ToolCall[] = [];
      let doneReason: string | undefined;
      let finished = false;
      let usage: TokenUsage | undefined;
      // Ollama itself takes no key; a proxy in front of it may.
    const headers = this.getHeaders(this.config.apiKey && this.config.apiKey !== "ollama" ? { Authorization: `Bearer ${this.config.apiKey}` } : {});
    for await (const data of this.streamLines(JSON.stringify(payload), url, headers, options, { ndjson: true })) {
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.error) {
          const error = new ProviderError(`Provider error (${json.status_code ?? 500}): ${String(json.error).slice(0, 800)}`, { status: json.status_code ?? 500, body: String(json.error) });
          error.midStream = emitted;
          throw error;
        }
        const message = json.message;
        if (message?.thinking) { emitted = true; cb.onReasoning?.(message.thinking); }
        if (message?.content) { emitted = true; cb.onToken(message.content); }
        for (const tc of message?.tool_calls ?? []) {
          const fn = tc.function ?? {};
          if (!fn.name) continue;
          emitted = true;
          calls.push({ id: typeof tc.id === "string" && tc.id ? tc.id : `ollama-call-${calls.length + 1}`, name: fn.name, arguments: toolCallsArgs(fn.arguments ?? {}) });
        }
        if (json.done) {
          finished = true;
          doneReason = json.done_reason;
          if (json.prompt_eval_count !== undefined || json.eval_count !== undefined) {
            usage = { inputTokens: Number(json.prompt_eval_count ?? 0), outputTokens: Number(json.eval_count ?? 0) };
          }
        }
      }
      if (!finished) throw incompleteStream();
      if (calls.length) cb.onToolCalls?.(calls);
      if (usage) cb.onUsage?.(usage);
      cb.onFinish?.(doneReason === "length" ? { reason: "length", raw: doneReason } : calls.length ? { reason: "tool_calls", raw: doneReason } : { reason: "stop", raw: doneReason });
      cb.onDone();
    } catch (e: any) {
      // Not a real Ollama (an OpenAI-compatible server on the same port, or a proxy): speak the other protocol.
      if (!emitted && e instanceof ProviderError && (e.status === 404 || e.status === 405)) {
        return new OpenAIProvider(this.config, this.runtime).chat(messages, tools, cb, options);
      }
      cb.onError(e);
    }
  }
}

export class CloudflareProvider extends OpenAIProvider {
  async chat(messages: ChatMessage[], tools: ToolDefinition[], cb: StreamCallbacks, requestOptions?: ChatOptions): Promise<void> {
    const accountId = this.config.cloudflareAccountId || "";
    if (!accountId) throw new Error("Cloudflare Account ID is required.");
    if (!this.config.apiKey) throw new Error("Cloudflare API Token is required.");

    const model = normalizeCloudflareModelId(this.config.model);
    const lower = model.toLowerCase();
    const task = String(this.config.cloudflareModelTask ?? "").toLowerCase();
    const options = this.runtime.modelOptions ?? {};
    const latestUser = [...messages].reverse().find((message) => message.role === "user");
    const prompt = latestUser?.content?.trim() || "";
    const parts = latestUser?.parts ?? [];
    const imagePart = parts.find((part) => part.type === "image" && part.data);
    const audioPart = parts.find((part) => part.type === "audio" && part.data);
    const schema = await fetchCloudflareModelSchema(this.config, model);
    const inputKeys = this.schemaKeys(schema?.input);
    const outputKeys = this.schemaKeys(schema?.output);

    const isImageGeneration = task.includes("text-to-image") || task.includes("image generation")
      || /flux|stable-diffusion|dreamshaper|sdxl|text-to-image|phoenix/.test(lower)
      || (!task && outputKeys.has("image") && !inputKeys.has("messages"));
    const isTranscription = task.includes("automatic speech recognition") || task.includes("speech-to-text")
      || /whisper|nova-3|speech-recognition|transcri/.test(lower);
    const isSpeech = task.includes("text-to-speech")
      || /melotts|aura-|text-to-speech|(^|[\/-])tts([\/-]|$)/.test(lower);
    const isEmbedding = task.includes("embedding")
      || /embedding|embed-|bge-|e5-/.test(lower);
    const isVision = !!imagePart || /vision|llava/.test(lower) || inputKeys.has("image");

    try {
      if (isImageGeneration) {
        const result = await this.runModel(model, { prompt: prompt || "Generate an image", steps: 4, ...options });
        const image = result?.image ?? result?.result?.image;
        if (!image) throw new Error("The image model returned no image data.");
        cb.onToken(`![Generated image](data:image/jpeg;base64,${image})`);
        cb.onDone();
        return;
      }

      if (isTranscription) {
        if (!audioPart?.data) throw new Error("This transcription model needs an audio attachment. Use the paperclip button and attach an audio file.");
        let result: any;
        try {
          result = await this.runModel(model, { audio: audioPart.data, task: "transcribe", ...options });
        } catch (error: any) {
          if (!String(error?.message ?? error).includes("8002")) throw error;
          result = await this.runModel(model, { audio: Array.from(Buffer.from(audioPart.data, "base64")), task: "transcribe", ...options });
        }
        const text = result?.text ?? result?.result?.text ?? result?.transcription_info?.text ?? result?.result?.transcription_info?.text;
        cb.onToken(text || JSON.stringify(result, null, 2));
        cb.onDone();
        return;
      }

      if (isSpeech) {
        const result = await this.runModel(model, { prompt: prompt || "Hello", ...options });
        const audio = result?.audio ?? result?.result?.audio;
        if (!audio) throw new Error("The speech model returned no audio data.");
        cb.onToken(`<audio controls src="data:audio/mpeg;base64,${audio}"></audio>\n\n[Download generated audio](data:audio/mpeg;base64,${audio})`);
        cb.onDone();
        return;
      }

      if (isEmbedding) {
        const result = await this.runModel(model, { text: prompt, ...options });
        const vectors = result?.data ?? result?.result?.data ?? result?.shape ?? result;
        cb.onToken(`Embedding generated successfully.\n\n\`\`\`json\n${JSON.stringify(vectors, null, 2).slice(0, 4000)}\n\`\`\``);
        cb.onDone();
        return;
      }

      if (isVision && imagePart?.data) {
        let result: any;
        const visionPayload = {
          prompt: prompt || "Describe this image in detail.",
          image: imagePart.data,
          max_tokens: this.maxOutput(requestOptions),
          temperature: this.runtime.temperature,
          ...options,
        };
        try {
          result = await this.runModel(model, visionPayload);
        } catch (error: any) {
          if (!String(error?.message ?? error).includes("8002")) throw error;
          result = await this.runModel(model, { ...visionPayload, image: Array.from(Buffer.from(imagePart.data, "base64")) });
        }
        cb.onToken(result?.response ?? result?.result?.response ?? result?.description ?? JSON.stringify(result, null, 2));
        cb.onDone();
        return;
      }

      // For non-chat tasks, construct the request from Cloudflare's live
      // model schema instead of sending an OpenAI chat payload to every model.
      if (schema && !inputKeys.has("messages") && !inputKeys.has("prompt_messages")) {
        const payload: Record<string, unknown> = {};
        if (inputKeys.has("prompt")) payload.prompt = prompt || "Run this model";
        if (inputKeys.has("text")) payload.text = prompt || "Run this model";
        if (inputKeys.has("query")) payload.query = prompt || "Run this model";
        if (inputKeys.has("image")) {
          if (!imagePart?.data) throw new Error("This model requires an image attachment. Use the paperclip button.");
          payload.image = imagePart.data;
        }
        if (inputKeys.has("audio")) {
          if (!audioPart?.data) throw new Error("This model requires an audio attachment. Use the paperclip button.");
          payload.audio = audioPart.data;
        }
        Object.assign(payload, options);
        const result = await this.runModel(model, payload);
        cb.onToken(this.renderModelResult(result));
        cb.onDone();
        return;
      }

      // Cloudflare officially supports this OpenAI-compatible endpoint for
      // every text-generation model. The model belongs in the JSON body —
      // never URL-encode @cf/... into a single /run path segment.
      const compatible = new OpenAIProvider({
        ...this.config,
        baseUrl: `${cloudflareApiBase(accountId)}/v1`,
        model,
      }, this.runtime);
      const supportedTools = !schema || inputKeys.has("tools") ? tools : [];
      return this.runTextWithFallback(compatible, messages, supportedTools, cb, model, inputKeys, options, requestOptions);
    } catch (error: any) {
      cb.onError(this.normalizeError(error));
    }
  }

  private async runTextWithFallback(
    compatible: OpenAIProvider,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    cb: StreamCallbacks,
    model: string,
    inputKeys: Set<string>,
    options: Record<string, string | number | boolean>,
    requestOptions?: ChatOptions
  ): Promise<void> {
    return await new Promise<void>((resolve) => {
      let emitted = false;
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      void compatible.chat(messages, tools, {
        onToken: (token) => { emitted = true; cb.onToken(token); },
        onReasoning: (token) => cb.onReasoning?.(token),
        onToolCalls: (calls) => cb.onToolCalls?.(calls),
        onUsage: (usage) => cb.onUsage?.(usage),
        onFinish: (info) => cb.onFinish?.(info),
        onDone: () => { cb.onDone(); finish(); },
        onError: async (error) => {
          const message = String(error?.message ?? error);
          if (emitted || !/\b400\b|bad input|invalid input/i.test(message)) {
            cb.onError(this.normalizeError(error));
            finish();
            return;
          }
          try {
            const nativeMessages = this.nativeTextMessages(messages);
            const transcript = nativeMessages.map((item) => `${item.role.toUpperCase()}: ${item.content}`).join("\n\n");
            const allowedOptions: Record<string, string | number | boolean> = {};
            for (const [key, value] of Object.entries(options)) {
              if (!inputKeys.size || inputKeys.has(key)) allowedOptions[key] = value;
            }
            const candidates: Array<Record<string, unknown>> = [];
            if (!inputKeys.size || inputKeys.has("messages")) {
              const payload: Record<string, unknown> = { messages: nativeMessages, ...allowedOptions };
              if (inputKeys.has("max_tokens")) payload.max_tokens = this.maxOutput(requestOptions);
              if (inputKeys.has("temperature") && this.runtime.temperature !== undefined) payload.temperature = this.runtime.temperature;
              candidates.push(payload);
            }
            if (!inputKeys.size || inputKeys.has("prompt")) {
              candidates.push({ prompt: transcript, ...allowedOptions });
            }
            if (!candidates.length) candidates.push({ prompt: transcript });

            let lastError: unknown = error;
            for (const payload of candidates) {
              try {
                const result = await this.runModel(model, payload);
                const reasoning = result?.reasoning_content ?? result?.reasoning ?? result?.thinking;
                if (typeof reasoning === "string" && reasoning) cb.onReasoning?.(reasoning);
                const calls = result?.tool_calls ?? result?.result?.tool_calls;
                if (Array.isArray(calls) && calls.length) {
                  cb.onToolCalls?.(calls.map((call: any, index: number) => ({
                    id: call.id ?? `cf-tool-${index}`,
                    name: call.name ?? call.function?.name ?? "",
                    arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? call.function?.arguments ?? {}),
                  })).filter((call: ToolCall) => call.name));
                } else {
                  cb.onToken(this.renderModelResult(result));
                }
                cb.onDone();
                finish();
                return;
              } catch (candidateError) {
                lastError = candidateError;
              }
            }
            cb.onError(this.normalizeError(lastError));
          } catch (fallbackError) {
            cb.onError(this.normalizeError(fallbackError));
          }
          finish();
        },
      }, requestOptions);
    });
  }

  private nativeTextMessages(messages: ChatMessage[]): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    return messages.map((message) => {
      const content = normalizedOpenAIContent(message.content);
      if (message.role === "tool") {
        const name = message.tool_name ?? "tool";
        return { role: "user" as const, content: `[Tool result: ${name}]\n${content}` };
      }
      if (message.role === "developer") return { role: "system" as const, content };
      if (message.role === "assistant" && message.tool_calls?.length && !content) {
        return { role: "assistant" as const, content: `Requested tools: ${message.tool_calls.map((call) => call.name).join(", ")}` };
      }
      const role = message.role === "system" || message.role === "assistant" ? message.role : "user";
      return { role, content };
    });
  }

  private async runModel(model: string, payload: Record<string, unknown>): Promise<any> {
    // Keep the model path hierarchy intact. encodeURIComponent(model) turns
    // slashes into %2F and Cloudflare returns error 7000: No route for URI.
    const modelPath = model.split("/").map((part, index) => index === 0 ? part : encodeURIComponent(part)).join("/");
    const url = `${cloudflareApiBase(this.config.cloudflareAccountId || "")}/run/${modelPath}`;
    const response: any = await requestUrl({
      url,
      method: "POST",
      headers: cloudflareHeaders(this.config.apiKey),
      body: JSON.stringify(payload),
      contentType: "application/json",
    } as any);
    if (response.status >= 400) throw new Error(`Cloudflare error ${response.status}: ${(response.text ?? "").slice(0, 700)}`);
    const contentType = String(response.headers?.["content-type"] ?? response.headers?.["Content-Type"] ?? "");
    const bytes = response.arrayBuffer ? Buffer.from(response.arrayBuffer) : null;
    if (bytes?.length) {
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
      const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      const isWebp = bytes.length > 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
      const isWave = bytes.length > 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE";
      const isMp3 = bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
      if (isJpeg || isPng || isWebp || contentType.includes("image/")) return { image: bytes.toString("base64") };
      if (isWave || isMp3 || contentType.includes("audio/")) return { audio: bytes.toString("base64") };
    }
    try {
      const json = response.json && typeof response.json !== "function"
        ? response.json
        : (typeof response.json === "function" ? response.json() : JSON.parse(response.text || "{}"));
      return json?.result ?? json;
    } catch {
      if (bytes?.length) {
        if (/flux|stable-diffusion|dreamshaper|sdxl|phoenix/.test(model.toLowerCase())) return { image: bytes.toString("base64") };
        return { audio: bytes.toString("base64") };
      }
      throw new Error("Cloudflare returned an unsupported binary response.");
    }
  }

  private schemaKeys(schema: any): Set<string> {
    const keys = new Set<string>();
    const visit = (node: any) => {
      if (!node || typeof node !== "object") return;
      if (node.properties && typeof node.properties === "object") {
        for (const [key, value] of Object.entries(node.properties)) {
          keys.add(key);
          visit(value);
        }
      }
      for (const key of ["oneOf", "anyOf", "allOf"]) {
        if (Array.isArray(node[key])) node[key].forEach(visit);
      }
      if (node.items) visit(node.items);
    };
    visit(schema);
    return keys;
  }

  private renderModelResult(result: any): string {
    const value = result?.result ?? result;
    const image = value?.image;
    if (typeof image === "string") return `![Generated image](data:image/jpeg;base64,${image})`;
    const audio = value?.audio;
    if (typeof audio === "string") return `<audio controls src="data:audio/mpeg;base64,${audio}"></audio>`;
    const text = value?.response ?? value?.text ?? value?.description;
    if (typeof text === "string") return text;
    return `\`\`\`json
${JSON.stringify(value, null, 2).slice(0, 8000)}
\`\`\``;
  }

  private normalizeError(error: any): Error {
    const message = String(error?.message ?? error);
    if (message.includes("7000") || message.includes("No route for that URI")) return new Error("Cloudflare could not route this model. Sync the catalog and select a canonical @cf/... model name.");
    if (message.includes("401") || message.includes("403")) return new Error("Cloudflare authentication failed. Check Account ID, API token, and Workers AI permissions.");
    if (message.includes("429")) return new Error("Cloudflare rate limit reached. Try again shortly or switch models.");
    if (/agree|license|acceptable use/i.test(message)) return new Error("This model requires accepting its license in Cloudflare before first use. Open the Workers AI model page, accept the terms, then retry.");
    if (/\b400\b|bad input/i.test(message)) return new Error(`Cloudflare rejected both compatible and native request formats for ${this.config.model}. Sync the catalog, reset this model's settings, and verify the model is enabled for your account.`);
    if (message.includes("8002") || message.toLowerCase().includes("invalid input")) return new Error("Cloudflare rejected the input for this model. Attach the required image/audio file or choose a model matching the task.");
    if (message.includes("timeout")) return new Error("Cloudflare request timed out. Retry or choose a faster model.");
    return new Error(message);
  }
}

export function createProvider(
  config: ProviderConfig,
  runtime: ProviderRuntimeOptions = {}
): BaseProvider {
  switch (config.type) {
    case "openai":
    case "openai-compatible":
    case "custom":
    case "openrouter":
      return new OpenAIProvider(config, runtime);
    case "ollama":
      return new OllamaProvider(config, runtime);
    case "cloudflare":
      return new CloudflareProvider(config, runtime);
    case "anthropic":
      return new AnthropicProvider(config, runtime);
    case "gemini":
      return new GeminiProvider(config, runtime);
    default:
      return new OpenAIProvider(config, runtime);
  }
}

/**
 * Probe a provider's `/models` endpoint (OpenAI-compatible) and return the
 * list of available model ids. Used to auto-detect models, verify the
 * connection works (correct base URL + API key), and validate that the
 * configured model actually exists.
 *
 * Returns { ok, models, error }.
 */
export async function probeModels(config: ProviderConfig): Promise<{
  ok: boolean;
  models: string[];
  error?: string;
}> {
  try {
    let url = "";
    let headers: Record<string, string> = { "Content-Type": "application/json" };

    if (config.type === "cloudflare") {
      const models = await fetchCloudflareModels(config);
      return { ok: true, models: models.map(m => m.id) };
    } else if (config.type === "gemini") {
      url = `${config.baseUrl.replace(/\/$/, "")}/models?key=${config.apiKey}`;
    } else if (config.type === "anthropic") {
      // Anthropic has no public models list via key; treat as ok if key present.
      if (!config.apiKey) return { ok: false, models: [], error: "API key required" };
      return { ok: true, models: [config.model] };
    } else {
      url = `${config.baseUrl.replace(/\/$/, "")}/models`;
      headers = { ...headers, Authorization: `Bearer ${config.apiKey}` };
    }

    if (config.extraHeaders) {
      try {
        Object.assign(headers, JSON.parse(config.extraHeaders));
      } catch { /* ignore */ }
    }

    let resp: any;
    if (config.type === "gemini") {
      resp = await requestUrl({ url, method: "GET" } as any);
    } else {
      resp = await requestUrl({ url, method: "GET", headers } as any);
    }

    if (resp.status >= 400) {
      return {
        ok: false,
        models: [],
        error: `HTTP ${resp.status}: ${(resp.text || "").slice(0, 300)}`,
      };
    }

    const json = typeof resp.json === "function" ? resp.json() : JSON.parse(resp.text || "{}");
    let models: string[] = [];
    if (config.type === "gemini") {
      models = (json.models ?? [])
        .map((m: any) => (m.name || "").replace(/^models\//, ""))
        .filter(Boolean);
    } else {
      models = (json.data ?? []).map((m: any) => m.id ?? m.name).filter(Boolean);
    }
    return { ok: true, models };
  } catch (e: any) {
    return { ok: false, models: [], error: e?.message ?? String(e) };
  }
}
