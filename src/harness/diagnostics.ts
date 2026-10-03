// ── harness/diagnostics.ts ────────────────────────────────────────────────
// When a model "gets worse" the cause is almost never the model alone: the
// window filled up and the oldest instructions were pushed out, an answer was
// cut off by a limit, a request was retried, a tool call arrived as text. The
// harness keeps a short log of what it did and why, and can print it with the
// model's profile as a report that can be copied into a bug report or just
// read, so the next time a model misbehaves there is something to look at.
// ─────────────────────────────────────────────────────────────────────────────

import type { ModelProfile } from "./model-profile";
import { formatTokens } from "./tokens";

export type HarnessEventKind =
  | "request"
  | "usage"
  | "retry"
  | "learned"
  | "negotiated"
  | "repair"
  | "text-tool-call"
  | "truncated"
  | "continued"
  | "compact"
  | "sanitize"
  | "loop-guard"
  | "empty"
  | "output-cut"
  | "attachment"
  | "error";

export interface HarnessEvent {
  at: number;
  kind: HarnessEventKind;
  message: string;
}

const MAX_EVENTS = 300;

export class HarnessLog {
  private events: HarnessEvent[] = [];
  private listeners = new Set<(event: HarnessEvent) => void>();

  add(kind: HarnessEventKind, message: string): void {
    const event: HarnessEvent = { at: Date.now(), kind, message };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* a listener must not break the run */ }
    }
  }

  all(): HarnessEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }

  onEvent(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The things that change how a model behaves, counted. */
  summary(): Record<HarnessEventKind, number> {
    const counts = {} as Record<HarnessEventKind, number>;
    for (const e of this.events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    return counts;
  }

  report(profile: ModelProfile | null, extra: Record<string, string | number | boolean | undefined> = {}): string {
    const lines: string[] = ["# Agenter harness report", ""];
    if (profile) {
      lines.push(`- Model: ${profile.model} (${profile.providerType}, ${profile.family})`);
      lines.push(`- Context window: ${formatTokens(profile.contextWindow)} tokens (${profile.contextSource})`);
      lines.push(`- Output limit: ${formatTokens(profile.maxOutput)} tokens (${profile.outputSource}), sent as \`${profile.outputParam}\``);
      lines.push(`- Reasoning model: ${profile.reasoning ? "yes" : "no"}; temperature accepted: ${profile.acceptsTemperature ? "yes" : "no"}`);
      lines.push(`- Native tool calling: ${profile.nativeTools ? "yes" : "no (learned)"}; vision: ${profile.vision ? "yes" : "no"}`);
      if (profile.numCtx) lines.push(`- Ollama context length requested: ${formatTokens(profile.numCtx)}`);
    }
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) lines.push(`- ${key}: ${value}`);
    }
    const counts = this.summary();
    lines.push("", "## What the harness did", "");
    const kinds = Object.keys(counts) as HarnessEventKind[];
    if (!kinds.length) lines.push("Nothing yet.");
    for (const kind of kinds) lines.push(`- ${kind}: ${counts[kind]}`);
    lines.push("", "## Events (newest last)", "");
    for (const e of this.events.slice(-80)) {
      lines.push(`${new Date(e.at).toISOString().slice(11, 19)} [${e.kind}] ${e.message}`);
    }
    return lines.join("\n");
  }
}
