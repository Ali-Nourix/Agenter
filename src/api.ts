import { ProviderConfig } from "./settings";
import { fetchCloudflareModels, fetchCloudflareModelSchema, cloudflareApiBase, cloudflareHeaders, normalizeCloudflareModelId } from "./cloudflare";
import { requestUrl } from "obsidian";
import { request as httpRequest, IncomingMessage } from "http";
import { request as httpsRequest } from "https";

export interface ProviderRuntimeOptions {
  maxTokens?: number;
  temperature?: number;
  modelOptions?: Record<string, string | number | boolean>;
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
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string;
  parts?: import("./provider-types").MessagePart[];
  metadata?: Record<string, unknown>;
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
  onReasoning?: (chunk: string) => void;
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
            content: normalizedOpenAIContent(m.content),
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
            content: normalizedOpenAIContent(m.content),
          };
        }
        return { role: m.role, content: normalizedOpenAIContent(m.content) };
      }),
      stream: true,
      temperature: this.runtime.temperature,
      max_tokens: this.runtime.maxTokens,
      ...(this.runtime.modelOptions ?? {}),
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
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking ?? json.reasoning;
        if (typeof reasoning === "string" && reasoning) cb.onReasoning?.(reasoning);
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


export class CloudflareProvider extends OpenAIProvider {
  async chat(messages: ChatMessage[], tools: ToolDefinition[], cb: StreamCallbacks): Promise<void> {
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
          max_tokens: this.runtime.maxTokens,
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
      return this.runTextWithFallback(compatible, messages, supportedTools, cb, model, inputKeys, options);
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
    options: Record<string, string | number | boolean>
  ): Promise<void> {
    return await new Promise<void>((resolve) => {
      let emitted = false;
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      void compatible.chat(messages, tools, {
        onToken: (token) => { emitted = true; cb.onToken(token); },
        onReasoning: (token) => cb.onReasoning?.(token),
        onToolCalls: (calls) => cb.onToolCalls?.(calls),
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
              if (inputKeys.has("max_tokens") && this.runtime.maxTokens) payload.max_tokens = this.runtime.maxTokens;
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
      });
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
    case "ollama":
      return new OpenAIProvider(config, runtime);
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

function safeParse(s: string): any {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}
