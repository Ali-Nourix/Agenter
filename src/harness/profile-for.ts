// ── harness/profile-for.ts ────────────────────────────────────────────────
// Joins the plugin's settings to the model profile: what the catalog says
// about the model, what was learned about it while running, and what the user
// set by hand.
// ─────────────────────────────────────────────────────────────────────────────

import type { AgentSettings, ProviderConfig } from "../settings";
import { LearnedModelInfo, ModelProfile, resolveModelProfile } from "./model-profile";

export function modelKey(provider: Pick<ProviderConfig, "id" | "model">): string {
  return `${provider.id}:${provider.model}`;
}

export function profileFor(settings: AgentSettings, provider: ProviderConfig): ModelProfile {
  const key = modelKey(provider);
  const catalog = settings.modelCatalogs?.[provider.id]?.models.find((m) => m.id === provider.model) ?? null;
  return resolveModelProfile({
    providerId: provider.id,
    providerType: provider.type,
    baseUrl: provider.baseUrl,
    model: provider.model,
    supportsVision: provider.supportsVision,
    catalog,
    learned: settings.modelLimits?.[key] ?? null,
    override: settings.modelOverrides?.[key] ?? null,
    localContextCap: settings.ollamaFullContext ? 0 : undefined,
  });
}

/** A limit on one answer that the user chose: in the model's own options, else the general setting. */
export function manualMaxOutput(settings: AgentSettings, provider: ProviderConfig): number | undefined {
  const own = Number(settings.modelOptions?.[modelKey(provider)]?.max_tokens);
  if (Number.isFinite(own) && own > 0) return Math.floor(own);
  return settings.maxTokens > 0 ? Math.floor(settings.maxTokens) : undefined;
}

export function learn(settings: AgentSettings, provider: ProviderConfig, patch: Partial<LearnedModelInfo>): LearnedModelInfo {
  if (!settings.modelLimits) settings.modelLimits = {};
  const key = modelKey(provider);
  const next: LearnedModelInfo = { ...(settings.modelLimits[key] ?? {}), ...patch, updatedAt: Date.now() };
  settings.modelLimits[key] = next;
  return next;
}

/**
 * Writes limits the provider reported, without overriding what was learned from an error (which is a limit the
 * request really hit). Returns whether anything changed.
 */
export function rememberReported(settings: AgentSettings, provider: ProviderConfig, found: { contextWindow?: number; maxOutput?: number } | null): boolean {
  if (!found || (!found.contextWindow && !found.maxOutput)) return false;
  const key = modelKey(provider);
  const existing = settings.modelLimits?.[key];
  const patch: Partial<LearnedModelInfo> = {};
  if (found.contextWindow && (!existing?.contextWindow || existing.contextSource === "api") && existing?.contextWindow !== found.contextWindow) {
    patch.contextWindow = found.contextWindow;
    patch.contextSource = "api";
  }
  if (found.maxOutput && (!existing?.maxOutput || existing.outputSource === "api") && existing?.maxOutput !== found.maxOutput) {
    patch.maxOutput = found.maxOutput;
    patch.outputSource = "api";
  }
  if (!Object.keys(patch).length) return false;
  learn(settings, provider, patch);
  return true;
}
