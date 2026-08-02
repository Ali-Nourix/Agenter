export type ProviderType = "openai-compatible" | "openai" | "anthropic" | "gemini" | "custom" | "ollama" | "openrouter" | "cloudflare";

export type MessageRole = "system" | "developer" | "user" | "assistant" | "tool";
export type Modality = "text" | "markdown" | "image" | "audio" | "video" | "pdf" | "document" | "file";

export interface MessagePart {
  type: Modality | "tool_call" | "tool_result" | "reasoning";
  text?: string;
  mimeType?: string;
  data?: string;
  url?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface ModelCapabilities {
  streaming: boolean;
  vision: boolean;
  imageGeneration: boolean;
  audio: boolean;
  speech: boolean;
  video: boolean;
  pdf: boolean;
  fileUpload: boolean;
  jsonMode: boolean;
  functionCalling: boolean;
  toolCalling: boolean;
  reasoning: boolean;
  embeddings: boolean;
  free: boolean;
  paid: boolean;
  experimental: boolean;
  deprecated: boolean;
  recommended: boolean;
  fast: boolean;
}

export interface ModelMetadata {
  id: string;
  provider: ProviderType | string;
  name: string;
  description?: string;
  task?: string;
  contextLength?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities: Modality[];
  outputModalities: Modality[];
  capabilities: ModelCapabilities;
  availability?: string;
  latency?: "low" | "medium" | "high" | string;
  pricing?: string;
  raw?: unknown;
}

export interface ModelCatalogCache {
  providerId: string;
  providerType: ProviderType | string;
  syncedAt: number;
  expiresAt: number;
  models: ModelMetadata[];
  error?: string;
}

export const EMPTY_CAPABILITIES: ModelCapabilities = {
  streaming: false,
  vision: false,
  imageGeneration: false,
  audio: false,
  speech: false,
  video: false,
  pdf: false,
  fileUpload: false,
  jsonMode: false,
  functionCalling: false,
  toolCalling: false,
  reasoning: false,
  embeddings: false,
  free: false,
  paid: false,
  experimental: false,
  deprecated: false,
  recommended: false,
  fast: false,
};

export function capabilityBadges(model?: ModelMetadata): string[] {
  if (!model) return [];
  const c = model.capabilities;
  const badges: string[] = [];
  if (c.free) badges.push("🆓 Free");
  if (c.paid) badges.push("💰 Paid");
  if (c.vision) badges.push("🖼 Vision");
  if (c.audio) badges.push("🎵 Audio");
  if (c.video) badges.push("🎥 Video");
  if (c.pdf) badges.push("📄 PDF");
  if (c.fileUpload) badges.push("📎 Files");
  if (c.reasoning) badges.push("🧠 Reasoning");
  if (c.toolCalling || c.functionCalling) badges.push("🔧 Tools");
  if (c.jsonMode) badges.push("{} JSON");
  if (c.fast) badges.push("⚡ Fast");
  if (c.recommended) badges.push("⭐ Recommended");
  if (c.experimental) badges.push("Experimental");
  if (c.deprecated) badges.push("Deprecated");
  return badges;
}
