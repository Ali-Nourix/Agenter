import { requestUrl } from "obsidian";
import { ProviderConfig } from "./settings";
import { EMPTY_CAPABILITIES, ModelMetadata, Modality } from "./provider-types";

const CATALOG_TTL = 1000 * 60 * 60 * 12;
const MODEL_SCHEMA_CACHE = new Map<string, any>();

export function cloudflareApiBase(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai`;
}

export function normalizeCloudflareModelId(id: string): string {
  return id.startsWith("@") ? id : `@cf/${id.replace(/^\/+/, "")}`;
}

export function cloudflareHeaders(token: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

export function inferCloudflareCapabilities(raw: any): ModelMetadata {
  const candidates = [raw.name, raw.model, raw.slug, raw.model_id, raw.properties?.name, raw.id]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => String(value).trim());
  const canonical = candidates.find((value) => value.startsWith("@cf/"))
    ?? candidates.find((value) => value.includes("/") && !/^[0-9a-f-]{32,36}$/i.test(value))
    ?? "";
  const id = canonical;
  const lower = `${id} ${raw.name ?? ""} ${raw.description ?? ""} ${raw.task?.name ?? raw.task ?? ""}`.toLowerCase();
  const task = String(raw.task?.name ?? raw.task ?? "").toLowerCase();
  const input: Modality[] = ["text"];
  const output: Modality[] = ["text"];
  const has = (s: string) => lower.includes(s) || task.includes(s);
  const image = has("vision") || has("image") || has("llava") || has("flux") || has("stable-diffusion");
  const imageGen = has("text-to-image") || has("image generation") || has("flux") || has("stable-diffusion");
  const audio = has("audio") || has("speech") || has("whisper") || has("tts");
  const embedding = has("embedding") || has("bge") || has("embed");
  const reasoning = has("reason") || has("r1") || has("qwq");
  if (image && !imageGen) input.push("image");
  if (imageGen) output.push("image");
  if (audio) input.push("audio");
  if (embedding) output.push("document");
  const context = Number(raw.properties?.context_window ?? raw.context_window ?? raw.contextLength ?? raw.context_length ?? 0) || undefined;
  return {
    id: normalizeCloudflareModelId(id),
    provider: "cloudflare",
    name: String(raw.display_name ?? raw.label ?? raw.name ?? id).replace(/^@cf\//, ""),
    description: raw.description,
    task: String(raw.task?.name ?? raw.task ?? ""),
    contextLength: context,
    contextWindow: context,
    maxOutputTokens: Number(raw.properties?.max_output_tokens ?? raw.max_output_tokens ?? 0) || undefined,
    inputModalities: input,
    outputModalities: output,
    availability: raw.public === false ? "private" : "available",
    latency: has("8b") || has("fast") ? "low" : undefined,
    pricing: raw.pricing ? JSON.stringify(raw.pricing) : undefined,
    raw,
    capabilities: {
      ...EMPTY_CAPABILITIES,
      streaming: !imageGen && !embedding,
      vision: image && !imageGen,
      imageGeneration: imageGen,
      audio,
      speech: has("tts") || has("speech"),
      pdf: has("pdf"),
      fileUpload: image || audio || has("document"),
      jsonMode: true,
      functionCalling: true,
      toolCalling: true,
      reasoning,
      embeddings: embedding,
      free: raw.pricing?.prompt === 0 || has("free"),
      paid: !(raw.pricing?.prompt === 0 || has("free")),
      experimental: has("beta") || has("experimental") || id.includes("-preview"),
      deprecated: has("deprecated"),
      recommended: has("llama-3.1") || has("llama-3.3") || has("qwen2.5") || has("mistral"),
      fast: has("8b") || has("fast"),
    },
  };
}

export async function fetchCloudflareModels(config: ProviderConfig): Promise<ModelMetadata[]> {
  if (!config.cloudflareAccountId) throw new Error("Cloudflare Account ID is required.");
  if (!config.apiKey) throw new Error("Cloudflare API Token is required.");
  const url = `${cloudflareApiBase(config.cloudflareAccountId)}/models/search`;
  const resp: any = await requestUrl({ url, method: "GET", headers: cloudflareHeaders(config.apiKey) } as any);
  if (resp.status === 401 || resp.status === 403) throw new Error("Cloudflare credentials are invalid or expired. Check Account ID and API token permissions.");
  if (resp.status === 429) throw new Error("Cloudflare rate limit reached. Try again shortly.");
  if (resp.status >= 500) throw new Error("Cloudflare Workers AI is temporarily unavailable.");
  if (resp.status >= 400) throw new Error(`Cloudflare error ${resp.status}: ${(resp.text ?? "").slice(0, 240)}`);
  const json = typeof resp.json === "function" ? resp.json() : JSON.parse(resp.text || "{}");
  const rows = Array.isArray(json.result) ? json.result : Array.isArray(json.result?.models) ? json.result.models : [];
  const models: ModelMetadata[] = (rows as any[])
    .map((row) => inferCloudflareCapabilities(row))
    .filter((model) => !!model.id && !/^@cf\/[0-9a-f-]{32,36}$/i.test(model.id));
  const unique: ModelMetadata[] = Array.from(
    new Map<string, ModelMetadata>(models.map((model) => [model.id, model])).values()
  );
  const taskRank = (model: ModelMetadata) => {
    const task = String(model.task ?? "").toLowerCase();
    if (task.includes("text generation")) return 0;
    if (task.includes("text-to-image") || model.capabilities.imageGeneration) return 1;
    if (task.includes("vision") || model.capabilities.vision) return 2;
    if (task.includes("speech-to-text") || task.includes("automatic speech")) return 3;
    if (task.includes("text-to-speech") || model.capabilities.speech) return 4;
    if (task.includes("embedding") || model.capabilities.embeddings) return 5;
    return 6;
  };
  const preferredAuthors = ["meta", "openai", "qwen", "mistral", "google"];
  const author = (model: ModelMetadata) => model.id.split("/")[1]?.toLowerCase() ?? "";
  unique.sort((a, b) => {
    const taskDiff = taskRank(a) - taskRank(b);
    if (taskDiff) return taskDiff;
    const aa = author(a), ba = author(b);
    const ai = preferredAuthors.indexOf(aa), bi = preferredAuthors.indexOf(ba);
    const authorDiff = (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    if (authorDiff) return authorDiff;
    const authorNameDiff = aa.localeCompare(ba);
    if (authorNameDiff) return authorNameDiff;
    const recommendedDiff = Number(b.capabilities.recommended) - Number(a.capabilities.recommended);
    if (recommendedDiff) return recommendedDiff;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return unique;
}


export async function fetchCloudflareModelSchema(config: ProviderConfig, modelId: string): Promise<any | null> {
  if (!config.cloudflareAccountId || !config.apiKey) return null;
  const model = normalizeCloudflareModelId(modelId);
  const key = `${config.cloudflareAccountId}:${model}`;
  if (MODEL_SCHEMA_CACHE.has(key)) return MODEL_SCHEMA_CACHE.get(key);
  try {
    const url = `${cloudflareApiBase(config.cloudflareAccountId)}/models/schema?model=${encodeURIComponent(model)}`;
    const response: any = await requestUrl({ url, method: "GET", headers: cloudflareHeaders(config.apiKey) } as any);
    if (response.status >= 400) return null;
    const json = response.json && typeof response.json !== "function"
      ? response.json
      : (typeof response.json === "function" ? response.json() : JSON.parse(response.text || "{}"));
    const schema = json?.result ?? null;
    if (schema) MODEL_SCHEMA_CACHE.set(key, schema);
    return schema;
  } catch {
    return null;
  }
}

export function cacheExpiry(): number { return Date.now() + CATALOG_TTL; }
