// ── harness/context-manager.ts ────────────────────────────────────────────
// A model's window is the whole of its memory for a request: instructions,
// tool definitions, the conversation, what tools returned, and the room its
// answer needs. A conversation that grows past it is refused; one that grows
// close to it is answered worse, because the model has to find the one line
// that matters in a mountain of old tool output. This keeps the request well
// inside the window and says how full it is, doing the least that works:
//
//   1. old tool results (the biggest and most disposable part) are replaced
//      by a one-line stub saying what was there and how to get it again;
//   2. if that is not enough, the oldest part of the conversation is
//      summarized by the model itself into one message, in rounds if it is
//      too long to be summarized at once;
//   3. if no summary can be had, the oldest turns are dropped, with a note;
//   4. as a last resort the largest messages are cut down.
//
// The latest user message and the last few tool rounds are never touched.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChatMessage, ToolDefinition } from "../api";
import { LimitSource, ModelProfile, outputLimitFor } from "./model-profile";
import { TokenCalibrator, TokenUsage, estimateConversationTokens, estimateMessageTokens, estimateTextTokens, estimateToolTokens } from "./tokens";
import { truncateMiddle } from "./tool-output";

export interface ContextSettings {
  autoCompact: boolean;
  /** Share of the window at which compaction starts, 0.5 to 0.95. */
  threshold: number;
  /** A limit the user set on a single answer, if any. */
  manualMaxOutput?: number;
}

export type ContextLevel = "ok" | "warn" | "high" | "full";

export interface ContextSnapshot {
  window: number;
  used: number;
  fraction: number;
  level: ContextLevel;
  source: "reported" | "estimated";
  windowSource: LimitSource;
  /** The room kept free for an answer before compaction starts. */
  reserve: number;
  /** Where compaction starts (tokens), and whether it is on. */
  trigger: number;
  autoCompact: boolean;
  /** The output limit a request made now would carry. */
  maxOutput: number;
  breakdown: { system: number; tools: number; history: number; pending: number };
}

export interface CompactionAction {
  kind: "clear-tool-results" | "summarize" | "drop" | "truncate";
  count: number;
  detail?: string;
}

export interface FitResult {
  messages: ChatMessage[];
  actions: CompactionAction[];
  before: number;
  after: number;
}

/** What the last request said its size was, and how much of the conversation it covered. */
export interface ReportedUsage {
  usage: TokenUsage;
  /** How many history messages (system excluded) the request carried, plus the answer. */
  historyLength: number;
}

const KEEP_RECENT_TOOL_RESULTS = 3;

export function contextKey(profile: Pick<ModelProfile, "providerId" | "model">): string {
  return `${profile.providerId}:${profile.model}`;
}

export function levelFor(fraction: number): ContextLevel {
  if (fraction >= 0.95) return "full";
  if (fraction >= 0.85) return "high";
  if (fraction >= 0.7) return "warn";
  return "ok";
}

/** Room kept for an answer: the model's output limit, but never more than a quarter of the window or 32k. */
export function outputReserve(profile: ModelProfile, manualMax?: number): number {
  return Math.max(1_024, Math.min(outputLimitFor(profile, manualMax), Math.floor(profile.contextWindow * 0.25), 32_000));
}

export function compactionTrigger(profile: ModelProfile, settings: ContextSettings): number {
  const threshold = Math.max(0.5, Math.min(0.95, settings.threshold || 0.8));
  return Math.min(Math.floor(profile.contextWindow * threshold), profile.contextWindow - outputReserve(profile, settings.manualMaxOutput));
}

/**
 * The output limit for a request whose input is `inputTokens`: the model's
 * maximum, or what is left of the window if that is less (providers refuse a
 * request whose input and output limit together exceed the window).
 */
export function requestMaxOutput(profile: ModelProfile, inputTokens: number, manualMax?: number): number {
  const cap = outputLimitFor(profile, manualMax);
  const safety = Math.max(256, Math.ceil(profile.contextWindow * 0.03));
  const room = profile.contextWindow - inputTokens - safety;
  return Math.max(256, Math.min(cap, room));
}

function isSyntheticUser(message: ChatMessage): boolean {
  const kind = message.metadata?.kind;
  return message.role === "user" && typeof kind === "string";
}

function argsSummary(args: string): string {
  try {
    const parsed = JSON.parse(args || "{}") as Record<string, unknown>;
    const first = parsed.path ?? parsed.query ?? parsed.url ?? parsed.folder ?? parsed.heading;
    if (typeof first === "string") return first.length > 60 ? `${first.slice(0, 57)}…` : first;
  } catch { /* ignore */ }
  return "";
}

/** The name and arguments of the call a tool result answers, for its stub. */
function describeCall(messages: ChatMessage[], toolIndex: number): string {
  const result = messages[toolIndex];
  for (let i = toolIndex - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.tool_calls) {
      const call = m.tool_calls.find((c) => c.id === result.tool_call_id);
      if (call) {
        const target = argsSummary(call.arguments);
        return target ? `${call.name} (${target})` : call.name;
      }
    }
  }
  return result.tool_name ?? "a tool";
}

export function transcriptOf(messages: ChatMessage[], toolLimitChars = 1_500): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") lines.push(`USER: ${m.content}`);
    else if (m.role === "assistant") {
      if (m.content?.trim()) lines.push(`ASSISTANT: ${m.content}`);
      for (const call of m.tool_calls ?? []) lines.push(`ASSISTANT called ${call.name}(${call.arguments.length > 400 ? `${call.arguments.slice(0, 400)}…` : call.arguments})`);
    } else if (m.role === "tool") {
      const cut = truncateMiddle(String(m.content ?? ""), toolLimitChars, "shortened for this summary");
      lines.push(`TOOL RESULT (${m.tool_name ?? "tool"}): ${cut.text}`);
    }
  }
  return lines.join("\n\n");
}

export const SUMMARY_SYSTEM =
  "You compress the earlier part of a conversation between a user and an AI assistant so the conversation can continue in a smaller space. " +
  "Write a dense summary that a different assistant could continue from without asking the user to repeat anything. " +
  "Keep: what the user wants and why; decisions made and the reasons; facts, names, numbers, dates, file and note paths, identifiers and quoted text that may be needed again; what has been done and what is still open; the user's preferences and constraints; the language they write in. " +
  "Drop: greetings, filler, tool output that is no longer needed (say only what it showed), and anything already superseded. " +
  "Write plain text with short bullet points, in the language of the conversation. Do not address the user. Do not add anything that was not said.";

export function summaryRequest(old: ChatMessage[], previous?: string): ChatMessage[] {
  const transcript = transcriptOf(old);
  const prior = previous ? `Summary so far, to be kept and extended:\n${previous}\n\nNew part of the conversation:\n` : "Conversation to summarize:\n";
  return [
    { role: "system", content: SUMMARY_SYSTEM },
    { role: "user", content: `${prior}${transcript}\n\nWrite the summary now.` },
  ];
}

export const SUMMARY_PREFIX = "[Earlier part of this conversation, summarized to save space]\n";

export class ContextManager {
  constructor(public readonly calibrator = new TokenCalibrator()) {}

  /** The size of a request, estimated and corrected by what providers have reported for this model. */
  measure(profile: ModelProfile, system: string, tools: ToolDefinition[], history: ChatMessage[]): number {
    const raw =
      estimateTextTokens(system) + 6 +
      estimateToolTokens(tools) +
      estimateConversationTokens(history, { includeReasoning: profile.passReasoningBack });
    return this.calibrator.apply(contextKey(profile), raw);
  }

  /** A provider has said how big a request really was. */
  learnFrom(profile: ModelProfile, estimatedRaw: number, usage: TokenUsage): void {
    this.calibrator.observe(contextKey(profile), estimatedRaw, usage.inputTokens);
  }

  rawEstimate(profile: ModelProfile, system: string, tools: ToolDefinition[], history: ChatMessage[]): number {
    return (
      estimateTextTokens(system) + 6 +
      estimateToolTokens(tools) +
      estimateConversationTokens(history, { includeReasoning: profile.passReasoningBack })
    );
  }

  snapshot(args: {
    profile: ModelProfile;
    system: string;
    tools: ToolDefinition[];
    history: ChatMessage[];
    pendingText?: string;
    settings: ContextSettings;
    reported?: ReportedUsage | null;
  }): ContextSnapshot {
    const { profile, system, tools, history, settings } = args;
    const key = contextKey(profile);
    const ratio = this.calibrator.ratio(key);
    const systemTokens = Math.ceil((estimateTextTokens(system) + 6) * ratio);
    const toolTokens = Math.ceil(estimateToolTokens(tools) * ratio);
    const pending = Math.ceil(estimateTextTokens(args.pendingText ?? "") * ratio);
    let historyTokens = Math.ceil(estimateConversationTokens(history, { includeReasoning: profile.passReasoningBack }) * ratio);
    let source: "reported" | "estimated" = "estimated";
    let used = systemTokens + toolTokens + historyTokens + pending;

    const reported = args.reported;
    if (reported && reported.usage.inputTokens > 0 && history.length >= reported.historyLength) {
      // What the provider counted for the last request, plus the answer it wrote, plus whatever has been added since.
      const answer = Math.max(0, reported.usage.outputTokens - (reported.usage.reasoningTokens ?? 0));
      const newer = history.slice(reported.historyLength);
      const since = newer.length ? Math.ceil(estimateConversationTokens(newer) * ratio) : 0;
      const total = reported.usage.inputTokens + answer + since + pending;
      source = "reported";
      historyTokens = Math.max(0, total - systemTokens - toolTokens - pending);
      used = total;
    }

    const fraction = used / profile.contextWindow;
    return {
      window: profile.contextWindow,
      used,
      fraction,
      level: levelFor(fraction),
      source,
      windowSource: profile.contextSource,
      reserve: outputReserve(profile, settings.manualMaxOutput),
      trigger: compactionTrigger(profile, settings),
      autoCompact: settings.autoCompact,
      maxOutput: requestMaxOutput(profile, used, settings.manualMaxOutput),
      breakdown: { system: systemTokens, tools: toolTokens, history: historyTokens, pending },
    };
  }

  /**
   * Brings a conversation back inside the window, if it has grown out of
   * it (or always, when forced). `conversation` starts with the system
   * message. It is not changed; the result carries the new one.
   */
  async fit(args: {
    profile: ModelProfile;
    conversation: ChatMessage[];
    tools: ToolDefinition[];
    settings: ContextSettings;
    force?: boolean;
    /** Writes a summary of the given turns, given the summary so far. Without it, old turns are dropped. */
    summarize?: (old: ChatMessage[], previous?: string) => Promise<string>;
    shouldAbort?: () => boolean;
  }): Promise<FitResult> {
    const { profile, tools, settings } = args;
    const system = args.conversation[0]?.role === "system" ? args.conversation[0] : null;
    let messages = system ? args.conversation.slice(1) : [...args.conversation];
    const systemText = system?.content ?? "";
    const measure = () => this.measure(profile, systemText, tools, messages);
    const before = measure();
    const actions: CompactionAction[] = [];

    const trigger = compactionTrigger(profile, settings);
    if (!args.force && (!settings.autoCompact || before <= trigger)) {
      return { messages: args.conversation, actions, before, after: before };
    }
    const target = args.force ? Math.min(Math.floor(profile.contextWindow * 0.5), Math.floor(before * 0.5)) : Math.min(Math.floor(profile.contextWindow * 0.5), Math.floor(trigger * 0.75));

    const rebuild = (): ChatMessage[] => (system ? [system, ...messages] : messages);

    // 1. Old tool results become stubs.
    {
      const toolIndexes: number[] = [];
      messages.forEach((m, i) => { if (m.role === "tool") toolIndexes.push(i); });
      const clearable = toolIndexes.slice(0, Math.max(0, toolIndexes.length - KEEP_RECENT_TOOL_RESULTS));
      let cleared = 0;
      let saved = 0;
      for (const i of clearable) {
        if (measure() <= target) break;
        const m = messages[i];
        const size = estimateMessageTokens(m);
        if (size <= 60) continue;
        const stub = `[Output cleared to save space: ${describeCall(messages, i)} returned ${String(m.content ?? "").length} characters. Call the tool again if it is needed.]`;
        messages[i] = { ...m, content: stub };
        cleared++;
        saved += size - estimateMessageTokens(messages[i]);
      }
      // Images from earlier rounds go too.
      let images = 0;
      const lastImageMessage = (() => { for (let i = messages.length - 1; i >= 0; i--) if (messages[i].metadata?.kind === "images") return i; return -1; })();
      messages = messages.map((m, i) => {
        if (m.metadata?.kind === "images" && i !== lastImageMessage && m.parts?.length) {
          images += m.parts.length;
          return { ...m, parts: undefined, content: `${m.content}\n[${m.parts.length} image(s) removed to save space]` };
        }
        return m;
      });
      if (cleared || images) {
        actions.push({ kind: "clear-tool-results", count: cleared, detail: `${saved} tokens${images ? `, ${images} image(s)` : ""}` });
      }
    }

    // 2./3. Summarize the oldest part, or drop it, unless clearing was enough to get comfortably under the trigger.
    if (measure() > (args.force ? target : Math.floor(trigger * 0.92))) {
      const lastUser = (() => { for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user" && !isSyntheticUser(messages[i])) return i; return 0; })();
      const fixed = Math.ceil(estimateTextTokens(systemText) * this.calibrator.ratio(contextKey(profile))) + estimateToolTokens(tools) + 1_800;
      const keepBudget = Math.max(1_000, target - fixed);
      // Walk back from the end until the kept tail would exceed its budget.
      let keepFrom = messages.length;
      let acc = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        acc += estimateMessageTokens(messages[i], { includeReasoning: profile.passReasoningBack });
        if (acc > keepBudget && i < messages.length - 1) break;
        keepFrom = i;
      }
      keepFrom = Math.min(keepFrom, lastUser);
      // A tool result must stay with its call, so the cut falls before an assistant or user message.
      while (keepFrom > 0 && messages[keepFrom].role === "tool") keepFrom--;
      if (keepFrom > 0) {
        const old = messages.slice(0, keepFrom);
        const kept = messages.slice(keepFrom);
        let summary = "";
        let summarized = false;
        if (args.summarize) {
          try {
            summary = await this.summarizeInRounds(profile, old, args.summarize, args.shouldAbort);
            summarized = summary.trim().length > 0;
          } catch {
            summarized = false;
          }
        }
        if (summarized) {
          messages = [{ role: "user", content: `${SUMMARY_PREFIX}${summary.trim()}`, metadata: { kind: "summary" } }, ...kept];
          actions.push({ kind: "summarize", count: old.length, detail: `${estimateConversationTokens(old)} → ${estimateTextTokens(summary)} tokens` });
        } else {
          messages = [{ role: "user", content: "[Earlier messages were removed to fit the context window. Ask the user if something from before is needed.]", metadata: { kind: "summary" } }, ...kept];
          actions.push({ kind: "drop", count: old.length });
        }
      }
    }

    // 4. Last resort: cut the largest messages down.
    if (measure() > Math.floor(profile.contextWindow - outputReserve(profile, settings.manualMaxOutput) / 2)) {
      const lastUser = (() => { for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i; return -1; })();
      let cut = 0;
      for (let pass = 0; pass < 6 && measure() > Math.floor(profile.contextWindow * 0.9); pass++) {
        let biggest = -1;
        let size = 0;
        messages.forEach((m, i) => {
          const s = estimateMessageTokens(m);
          if (s > size && s > 400) { size = s; biggest = i; }
        });
        if (biggest < 0) break;
        const m = messages[biggest];
        const keepChars = Math.max(1_000, Math.floor(String(m.content ?? "").length / 2));
        const t = truncateMiddle(String(m.content ?? ""), keepChars, "Shortened to fit the context window");
        messages[biggest] = { ...m, content: t.text };
        cut++;
        if (biggest === lastUser && cut > 4) break;
      }
      if (cut) actions.push({ kind: "truncate", count: cut });
    }

    return { messages: rebuild(), actions, before, after: measure() };
  }

  private async summarizeInRounds(
    profile: ModelProfile,
    old: ChatMessage[],
    summarize: (old: ChatMessage[], previous?: string) => Promise<string>,
    shouldAbort?: () => boolean
  ): Promise<string> {
    // Each round has to fit in the window with room for the summary: about a third of it for the transcript.
    const roundBudget = Math.max(2_000, Math.floor(profile.contextWindow * 0.35));
    const rounds: ChatMessage[][] = [];
    let current: ChatMessage[] = [];
    let size = 0;
    for (const m of old) {
      const s = Math.min(estimateMessageTokens(m), 600 + Math.ceil(1_500 / 3));
      if (current.length && size + s > roundBudget) { rounds.push(current); current = []; size = 0; }
      current.push(m);
      size += s;
    }
    if (current.length) rounds.push(current);
    let summary = "";
    for (const round of rounds) {
      if (shouldAbort?.()) throw new Error("aborted");
      summary = await summarize(round, summary || undefined);
    }
    return summary;
  }
}
