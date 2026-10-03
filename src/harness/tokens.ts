// ── harness/tokens.ts ─────────────────────────────────────────────────────
// How many tokens a piece of text, a message or a whole request is worth.
// No tokenizer ships with the plugin (each provider has its own), so this is
// an estimate that corrects itself: every time a provider reports the real
// size of a request, the ratio between the two is kept and applied to the
// next estimate. Persian, Arabic and Hebrew cost far more tokens per
// character than English, and CJK costs about one per character; both are
// counted separately so the bar is not wildly wrong for those languages.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChatMessage, ToolDefinition } from "../api";

export interface TokenUsage {
  /** Tokens the provider read for this request (the whole prompt). */
  inputTokens: number;
  /** Tokens the model wrote, thinking included where the provider counts it. */
  outputTokens: number;
  /** Part of the input served from a cache, where the provider says so. */
  cachedTokens?: number;
  /** Part of the output spent thinking, where the provider says so. */
  reasoningTokens?: number;
}

const CJK = /[⺀-鿿豈-﫿＀-￯぀-ヿ가-힯]/;
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

/** Characters per token for plain Latin text, a little pessimistic on purpose: running out is worse than leaving room. */
const LATIN_CHARS_PER_TOKEN = 3.6;
const RTL_CHARS_PER_TOKEN = 2.2;
const CJK_TOKENS_PER_CHAR = 1;
/** What an image costs a model that can see, whatever its size (providers range from ~85 to ~1600). */
export const IMAGE_TOKENS = 1100;
/** What a page of a PDF costs a model that reads it as it is (its text and the page as an image). */
export const PDF_PAGE_TOKENS = 1_700;
/** Wrapping around every message: role markers, separators. */
const MESSAGE_OVERHEAD = 4;

export function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0;
  let latin = 0;
  let rtl = 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch < "֐") latin++;
    else if (RTL.test(ch)) rtl++;
    else if (CJK.test(ch)) cjk++;
    else latin++;
  }
  return Math.ceil(latin / LATIN_CHARS_PER_TOKEN + rtl / RTL_CHARS_PER_TOKEN + cjk * CJK_TOKENS_PER_CHAR);
}

export function estimateMessageTokens(message: ChatMessage, opts: { includeReasoning?: boolean } = {}): number {
  let total = MESSAGE_OVERHEAD + estimateTextTokens(message.content);
  if (message.tool_calls) {
    for (const call of message.tool_calls) {
      total += 8 + estimateTextTokens(call.name) + estimateTextTokens(call.arguments);
    }
  }
  if (message.parts) {
    for (const part of message.parts) {
      if (part.type === "image") total += IMAGE_TOKENS;
      else if (part.type === "pdf") total += PDF_PAGE_TOKENS * Math.max(1, Number(part.metadata?.pages ?? 8));
      else if (part.type === "audio") total += 600;
    }
  }
  if (opts.includeReasoning && message.reasoning) total += estimateTextTokens(message.reasoning);
  return total;
}

export function estimateToolTokens(tools: ToolDefinition[]): number {
  if (!tools.length) return 0;
  let total = 0;
  for (const tool of tools) {
    total += 12 + estimateTextTokens(tool.name) + estimateTextTokens(tool.description) + estimateTextTokens(JSON.stringify(tool.parameters ?? {}));
  }
  return total;
}

export function estimateConversationTokens(messages: ChatMessage[], opts: { includeReasoning?: boolean } = {}): number {
  let total = 3;
  for (const message of messages) total += estimateMessageTokens(message, opts);
  return total;
}

/**
 * Learns how far off the estimate is for one model, from the sizes providers
 * report. The ratio moves slowly (so one odd request does not swing the bar)
 * and is kept within a sane range.
 */
export class TokenCalibrator {
  private ratios = new Map<string, number>();

  ratio(key: string): number {
    return this.ratios.get(key) ?? 1;
  }

  observe(key: string, estimated: number, actual: number): void {
    if (!(estimated > 200) || !(actual > 0)) return;
    const seen = Math.min(3, Math.max(0.4, actual / estimated));
    const previous = this.ratios.get(key);
    this.ratios.set(key, previous === undefined ? seen : previous * 0.6 + seen * 0.4);
  }

  apply(key: string, estimated: number): number {
    return Math.ceil(estimated * this.ratio(key));
  }
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1).replace(/\.?0+$/, "")}M`;
}
