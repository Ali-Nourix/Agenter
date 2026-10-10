// ── harness/limits-fetch.ts ───────────────────────────────────────────────
// Asks the provider what a model can take in and give back, where the
// provider has an API that says so: OpenRouter, Gemini, Anthropic and Ollama
// list the numbers, and many OpenAI-compatible servers (vLLM, LM Studio,
// Together, Groq, Mistral) put them in their model list under a name of
// their own. What cannot be asked is learned from the first error that
// names it (see model-profile.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { requestUrl } from "obsidian";
import type { ProviderConfig } from "../settings";
import { ollamaOrigin } from "../api";

export interface FetchedLimits {
  contextWindow?: number;
  maxOutput?: number;
}

function num(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** The context and output numbers in a model entry, under whichever names servers use for them. */
export function limitsFromEntry(entry: any): FetchedLimits {
  if (!entry || typeof entry !== "object") return {};
  const context =
    num(entry.context_length) ??
    num(entry.max_model_len) ??
    num(entry.context_window) ??
    num(entry.max_context_length) ??
    num(entry.loaded_context_length) ??
    num(entry.inputTokenLimit) ??
    num(entry.max_input_tokens) ??
    num(entry.context) ??
    num(entry.n_ctx_train) ??
    num(entry.meta?.n_ctx_train);
  const output =
    num(entry.top_provider?.max_completion_tokens) ??
    num(entry.max_completion_tokens) ??
    num(entry.max_output_tokens) ??
    num(entry.outputTokenLimit) ??
    (entry.max_tokens !== undefined && entry.max_input_tokens !== undefined ? num(entry.max_tokens) : undefined);
  return { contextWindow: context, maxOutput: output };
}

async function getJson(url: string, headers: Record<string, string> = {}, method: "GET" | "POST" = "GET", body?: unknown): Promise<any> {
  const resp: any = await requestUrl({
    url,
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    throw: false,
  } as any);
  if (resp.status >= 400) throw new Error(`HTTP ${resp.status}`);
  return typeof resp.json === "function" ? resp.json() : resp.json ?? JSON.parse(resp.text || "{}");
}

export async function fetchModelLimits(provider: ProviderConfig): Promise<FetchedLimits | null> {
  const base = provider.baseUrl.replace(/\/$/, "");
  try {
    let extra: Record<string, string> = {};
    try { extra = provider.extraHeaders ? JSON.parse(provider.extraHeaders) : {}; } catch { /* ignored */ }
    switch (provider.type) {
      case "gemini": {
        const json = await getJson(`${base}/models/${provider.model.replace(/^models\//, "")}`, { "x-goog-api-key": provider.apiKey, ...extra });
        return limitsFromEntry(json);
      }
      case "anthropic": {
        const json = await getJson(`${base}/models/${provider.model}`, { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01", ...extra });
        return limitsFromEntry(json);
      }
      case "ollama": {
        const json = await getJson(`${ollamaOrigin(provider.baseUrl)}/api/show`, extra, "POST", { model: provider.model });
        const info = json?.model_info ?? {};
        const key = Object.keys(info).find((k) => k.endsWith(".context_length"));
        return key ? { contextWindow: num(info[key]) } : null;
      }
      case "cloudflare":
        return null;
      case "openai":
        return null;
      default: {
        const json = await getJson(`${base}/models`, { Authorization: `Bearer ${provider.apiKey}`, ...extra });
        const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
        const entry = list.find((m) => (m.id ?? m.name) === provider.model);
        const found = limitsFromEntry(entry);
        return found.contextWindow || found.maxOutput ? found : null;
      }
    }
  } catch {
    return null;
  }
}
