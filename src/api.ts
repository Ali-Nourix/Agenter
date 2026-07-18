import { ProviderConfig } from "./settings";
import { requestUrl } from "obsidian";
import { request as httpRequest, IncomingMessage } from "http";
import { request as httpsRequest } from "https";

export interface ProviderRuntimeOptions {
  maxTokens?: number;
  temperature?: number;
}

/**
 * Stream SSE directly through Node/Electron. Obsidian's requestUrl is
 * CORS-safe but normally buffers the complete response, which delays the
 * first visible token until generation has already finished.
 */
async function* nativeNodeStream(
  url: string,
  headers: Record<string, string>,
  body: string
): AsyncGenerator<string> {
  const target = new URL(url);
  const requestFn = target.protocol === "http:" ? httpRequest : httpsRequest;

  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = requestFn(
      target,
      {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
      },
      resolve
    );
    req.once("error", reject);
    req.setTimeout(120_000, () => {
      req.destroy(new Error("Provider request timed out after 120 seconds."));
    });
    req.write(body);
    req.end();
  });

  if ((response.statusCode ?? 500) >= 400) {
    let errorBody = "";
    for await (const chunk of response) {
      errorBody += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (errorBody.length > 2000) break;
    }
    throw new Error(
      `Provider error (${response.statusCode}): ${errorBody.slice(0, 500)}`
    );
  }

  let buffer = "";
  for await (const chunk of response) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      if (data) yield data;
    }
  }

  const trailing = buffer.trim();
  if (trailing.startsWith("data:")) {
    const data = trailing.slice(5).trim();
    if (data && data !== "[DONE]") yield data;
  }
}

/**
 * CORS-safe streaming fetch using Obsidian's `requestUrl`, which routes
 * through Electron and is NOT subject to browser CORS restrictions. This
 * lets custom providers (e.g. opencode.ai, local servers) work without
 * Access-Control-Allow-Origin errors.
 *
 * Yields one SSE `data:` payload per call (already trimmed, JSON string).
 */
async function* obsidianStream(
  url: string,
  headers: Record<string, string>,
  body: string
): AsyncGenerator<string> {
  const resp = await requestUrl({
    url,
    method: "POST",
    headers,
    body,
    contentType: "application/json",
  } as any);

  const raw: any = resp as any;
  if (raw.body && typeof raw.body.getReader === "function") {
    const reader = raw.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        yield data;
      }
    }
    return;
  }

  // Fallback: buffered body. requestUrl returns the full SSE text at once.
  // We parse the SSE stream into individual `data:` JSON chunks and emit
  // them with a tiny delay so the UI still feels like live streaming.
  const text: string = raw.text ?? "";
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") return;
    yield data;
    // Small yield to let the event loop breathe (approximate streaming).
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Unified message + tool types used across all providers.
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** For tool-result messages */
  tool_call_id?: string;
  /** Original function name for providers such as Gemini. */
  tool_name?: string;
  /** For assistant tool calls */
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: object; // JSON schema
}

export interface StreamCallbacks {
  onToken: (chunk: string) => void;
  onToolCalls?: (calls: ToolCall[]) => void;
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

  constructor(config: ProviderConfig, runtime: ProviderRuntimeOptions = {}) {
    this.config = config;
    this.runtime = runtime;
  }

  abstract chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    cb: StreamCallbacks
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

  protected async *streamLines(
    body: string,
    url: string,
    headers: Record<string, string>
  ): AsyncGenerator<string> {
    let emitted = false;
    try {
      for await (const data of nativeNodeStream(url, headers, body)) {
        emitted = true;
        yield data;
      }
    } catch (error: any) {
      if (emitted || String(error?.message ?? error).includes("Provider error")) {
        throw error;
      }
      yield* obsidianStream(url, headers, body);
    }
  }
}

/**
 * OpenAI and OpenAI-compatible endpoints (DeepSeek, Qwen, OpenRouter, vLLM, etc.)
 * This adapter also covers the generic "custom" type when it speaks the
 * OpenAI chat/completions protocol.
 */
export class OpenAIProvider extends BaseProvider {
  chat(messages: ChatMessage[], tools: ToolDefinition[], cb: StreamCallbacks): Promise<void> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const headers = this.getHeaders({ Authorization: `Bearer ${this.config.apiKey}` });

    const payload: any = {
      model: this.config.model,
      messages: messages.map((m) => {
        if (m.role === "assistant" && m.tool_calls) {
          return {
            role: "assistant",
            content: m.content || null,
            tool_calls: m.tool_calls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
            })),
          };
        }
        if (m.role === "tool") {
          return {
            role: "tool",
            tool_call_id: m.tool_call_id,
            content: m.content,
          };
        }
        return { role: m.role, content: m.content };
      }),
      stream: true,
      temperature: this.runtime.temperature,
      max_tokens: this.runtime.maxTokens,
    };
    if (tools.length) {
      payload.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      payload.tool_choice = "auto";
    }

    return this.runStream(url, headers, payload, cb);
  }

  private async runStream(
    url: string,
    headers: Record<string, string>,
    payload: any,
    cb: StreamCallbacks
  ): Promise<void> {
    try {
      const collectedToolCalls = new Map<string, { name: string; args: string }>();
      const indexToKey = new Map<number, string>();
      for await (const data of this.streamLines(JSON.stringify(payload), url, headers)) {
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) cb.onToken(delta.content);
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const key =
              tc.id ??
              (tc.index !== undefined
                ? indexToKey.get(tc.index) ?? `index-${tc.index}`
                : "index-0");
            if (tc.index !== undefined) indexToKey.set(tc.index, key);
            const existing = collectedToolCalls.get(key) ?? { name: "", args: "" };
            if (tc.function?.name) existing.name = tc.function.name;
            if (existing && tc.function?.arguments) {
              existing.args += tc.function.arguments;
            }
            collectedToolCalls.set(key, existing);
          }
        }
      }
      if (collectedToolCalls.size) {
        const calls: ToolCall[] = Array.from(collectedToolCalls.entries()).map(([id, v]) => ({
          id,
          name: v.name,
          arguments: v.args,
        }));
        cb.onToolCalls?.(calls);
      }
      cb.onDone();
    } catch (e) {
      cb.onError(e as Error);
    }
  }
}

/**
 * Anthropic Messages API adapter. Tool use is native.
 */
export class AnthropicProvider extends BaseProvider {
  chat(messages: ChatMessage[], tools: ToolDefinition[], cb: StreamCallbacks): Promise<void> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/messages`;
    const headers = this.getHeaders({
      "x-api-key": this.config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    });

    // Convert roles: Anthropic only accepts user/assistant.
    const sys = messages.filter((m) => m.role === "system").map((m) => m.content);
    const turns: any[] = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "user") {
        turns.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        if (m.tool_calls && m.tool_calls.length) {
          turns.push({
            role: "assistant",
            content: m.tool_calls.map((tc) => ({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: safeParse(tc.arguments),
            })),
          });
        } else {
          turns.push({ role: "assistant", content: m.content });
        }
      } else if (m.role === "tool") {
        // tool result -> user message with tool_result block
        turns.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m.tool_call_id,
              content: m.content,
            },
          ],
        });
      }
    }

    const payload: any = {
      model: this.config.model,
      max_tokens: this.runtime.maxTokens ?? 4096,
      temperature: this.runtime.temperature,
      system: sys.join("\n"),
      messages: turns,
      stream: true,
    };
    if (tools.length) {
      payload.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    return this.runStream(url, headers, payload, cb);
  }

  private async runStream(
    url: string,
    headers: Record<string, string>,
    payload: any,
    cb: StreamCallbacks
  ): Promise<void> {
    try {
      let textBuf = "";
      const toolUses = new Map<string, { name: string; args: string }>();
      const indexToKey = new Map<number, string>();
      for await (const data of this.streamLines(JSON.stringify(payload), url, headers)) {
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        switch (json.type) {
          case "content_block_delta":
            if (json.delta?.type === "text_delta") {
              textBuf += json.delta.text;
              cb.onToken(json.delta.text);
            } else if (json.delta?.type === "input_json_delta") {
              const id =
                json.index !== undefined
                  ? indexToKey.get(json.index) ?? `tu-${json.index}`
                  : "tu-0";
              if (json.index !== undefined) indexToKey.set(json.index, id);
              const ex = toolUses.get(id) ?? { name: "", args: "" };
              ex.args += json.delta.partial_json;
              toolUses.set(id, ex);
            }
            break;
          case "content_block_start":
            if (json.content_block?.type === "tool_use") {
              const id = json.content_block.id;
              if (json.index !== undefined) indexToKey.set(json.index, id);
              toolUses.set(id, {
                name: json.content_block.name,
                args: "",
              });
            }
            break;
        }
      }
      if (toolUses.size) {
        const calls: ToolCall[] = Array.from(toolUses.entries()).map(([id, v]) => ({
          id,
          name: v.name,
          arguments: v.args,
        }));
        cb.onToolCalls?.(calls);
      }
      cb.onDone();
    } catch (e) {
      cb.onError(e as Error);
    }
  }
}

/**
 * Google Gemini adapter (generativelanguage API). Tool use + web search supported.
 */
export class GeminiProvider extends BaseProvider {
  chat(messages: ChatMessage[], tools: ToolDefinition[], cb: StreamCallbacks): Promise<void> {
    // Gemini path: baseUrl/v1beta/models/{model}:streamGenerateContent?alt=sse&key=...
    const model = this.config.model;
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/models/${model}:streamGenerateContent?alt=sse&key=${this.config.apiKey}`;

    const contents: any[] = [];
    let systemInstruction = "";
    for (const m of messages) {
      if (m.role === "system") {
        systemInstruction += m.content + "\n";
        continue;
      }
      if (m.role === "user") {
        contents.push({ role: "user", parts: [{ text: m.content }] });
      } else if (m.role === "assistant") {
        if (m.tool_calls && m.tool_calls.length) {
          contents.push({
            role: "model",
            parts: m.tool_calls.map((tc) => ({
              functionCall: { name: tc.name, args: safeParse(tc.arguments) },
            })),
          });
        } else {
          contents.push({ role: "model", parts: [{ text: m.content }] });
        }
      } else if (m.role === "tool") {
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: m.tool_name ?? m.tool_call_id ?? "tool",
                response: { result: m.content },
              },
            },
          ],
        });
      }
    }

    const payload: any = {
      contents,
      systemInstruction: systemInstruction
        ? { parts: [{ text: systemInstruction }] }
        : undefined,
      generationConfig: {
        maxOutputTokens: this.runtime.maxTokens,
        temperature: this.runtime.temperature,
      },
    };

    const geminiTools: any[] = [];
    if (tools.length) {
      geminiTools.push({
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      });
    }
    if (this.config.supportsWebSearch) {
      geminiTools.push({ googleSearch: {} });
    }
    if (geminiTools.length) payload.tools = geminiTools;

    return this.runStream(url, this.getHeaders(), payload, cb);
  }

  private async runStream(
    url: string,
    headers: Record<string, string>,
    payload: any,
    cb: StreamCallbacks
  ): Promise<void> {
    try {
      const toolCalls = new Map<string, { name: string; args: string }>();
      for await (const data of this.streamLines(JSON.stringify(payload), url, headers)) {
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        const parts = json.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part.text) cb.onToken(part.text);
          if (part.functionCall) {
            const id = `fc-${part.functionCall.name}`;
            toolCalls.set(id, {
              name: part.functionCall.name,
              args: JSON.stringify(part.functionCall.args ?? {}),
            });
          }
        }
      }
      if (toolCalls.size) {
        const calls: ToolCall[] = Array.from(toolCalls.entries()).map(([id, v]) => ({
          id,
          name: v.name,
          arguments: v.args,
        }));
        cb.onToolCalls?.(calls);
      }
      cb.onDone();
    } catch (e) {
      cb.onError(e as Error);
    }
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
      return new OpenAIProvider(config, runtime);
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

    if (config.type === "gemini") {
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

function safeParse(s: string): any {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}
