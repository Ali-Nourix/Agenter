import { App } from "obsidian";
import { AgentSettings, ProviderConfig, getActiveProvider } from "./settings";
import { createProvider, ChatMessage, ToolDefinition, ToolCall, BaseProvider, FinishInfo } from "./api";
import { MessagePart } from "./provider-types";
import { ToolRegistry, VaultAccessRequest, VaultAccessScope } from "./tools";
import {
  ContextManager,
  ContextSettings,
  ContextSnapshot,
  FitResult,
  HarnessServices,
  ModelProfile,
  ReportedUsage,
  createHarnessServices,
  formatTokens,
  learn,
  manualMaxOutput,
  profileFor,
  requestMaxOutput,
  summaryRequest,
} from "./harness";
import { AbortedError, ClassifiedError, classifyError, explainError, retryDelayMs } from "./harness/errors";
import { parseToolArguments } from "./harness/json-repair";
import { INTERRUPTED_RESULT, describeReport, reportIsClean, sanitizeConversation } from "./harness/sanitize";
import { ToolCallTextGuard, extractTextToolCalls, matchToolName } from "./harness/text-tool-calls";
import { prepareToolOutput } from "./harness/tool-output";
import { promptToolsAddendum, toPromptMessages } from "./harness/prompt-tools";
import type { TokenUsage } from "./harness/tokens";
import { PreparedTurn, prepareUserTurn } from "./harness/attachments";

export interface HarnessNotice {
  kind: "retry" | "compact" | "repair" | "info" | "warning";
  text: string;
}

export interface ChatCallbacks {
  onAssistantToken: (token: string) => void;
  onReasoningToken?: (token: string) => void;
  onToolUse: (name: string, args: string) => void;
  onToolResult: (result: string) => void;
  onError: (err: string) => void;
  onDone: () => void;
  /**
   * Called before a mutating tool runs when it requires approval.
   * Resolve true to run the tool, false to skip it. If omitted, all
   * tools run without prompting.
   */
  onApprovalRequest?: (call: ToolCall) => Promise<boolean>;
  /** Ask for temporary note/folder/vault access without ending the run. */
  onAccessRequest?: (request: VaultAccessRequest) => Promise<boolean>;
  /** Something the harness did that the person should know: a retry, a compaction, a repaired call. */
  onNotice?: (notice: HarnessNotice) => void;
  /** What was streamed for this answer so far is void: the request is being made again. */
  onStreamReset?: () => void;
  /** How full the model's window is, as it changes during the run. */
  onContext?: (snapshot: ContextSnapshot) => void;
}

const ACCESS_PROTOCOL = [
  "Access protocol:",
  "- You can request temporary note, folder, or vault access with request_access.",
  "- If the user asks you to get access, call request_access immediately; never say you cannot request it.",
  "- If the task needs context outside the initial scope, request the smallest sufficient scope proactively.",
  "- After approval, continue the same run and call the relevant read/list/search tool.",
  "- A denied request is not a failed session; continue within the available context.",
].join("\n");

const MAX_CONTINUATIONS = 8;
const MAX_ATTEMPTS_TRANSIENT = 5;
const MAX_NEGOTIATIONS = 6;
const MAX_NUDGES = 2;
const REPEAT_WARN = 3;
const REPEAT_STOP = 6;

interface RunContext {
  provider: ProviderConfig;
  profile: ModelProfile;
  /** Every tool there is, for resolving and running calls. */
  tools: ToolDefinition[];
  /** The tools sent with the request: none when the model gets them in its prompt. */
  sendTools: ToolDefinition[];
  promptTools: boolean;
  conversation: ChatMessage[];
  baseSystem: string;
  manualMax?: number;
  /** An output limit worked out from an error that said how much room the input left, for this request only. */
  outputCeiling?: number;
  signal: AbortSignal;
  cb: ChatCallbacks;
}

interface TurnResult {
  text: string;
  reasoning: string;
  calls: ToolCall[];
  finish: FinishInfo;
  usage?: TokenUsage;
  shown: boolean;
  guard: ToolCallTextGuard;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Drives a single conversation: sends messages to the active provider,
 * executes any tool calls the model requests, feeds results back, and
 * repeats until the model produces a final (tool-free) answer.
 *
 * Around that loop sits the harness (src/harness): it keeps the request
 * inside the model's window, learns the model's real limits, repairs what
 * models get wrong in tool calls, retries what is only temporary, and
 * records what it did.
 *
 * Supports cooperative aborting via shouldAbort(), which also closes the
 * connection to the provider.
 */
export class AgentOrchestrator {
  private app: App;
  private settings: AgentSettings;
  private toolRegistry: ToolRegistry;
  private services: HarnessServices;
  public messages: ChatMessage[] = [];
  public shouldAbort: () => boolean = () => false;
  private reported: ReportedUsage | null = null;

  constructor(app: App, settings: AgentSettings, services?: HarnessServices) {
    this.app = app;
    this.settings = settings;
    this.toolRegistry = new ToolRegistry(app);
    this.services = services ?? createHarnessServices(() => undefined);
  }

  get context(): ContextManager {
    return this.services.context;
  }

  setMessages(messages: ChatMessage[]) {
    const same = messages.length === this.messages.length && messages.every((m, i) => m === this.messages[i]);
    if (!same) this.reported = null;
    this.messages = messages;
  }

  setAccessScope(scope: VaultAccessScope): void {
    this.toolRegistry.setAccessScope(scope);
  }

  // ── what the person sees of the window ──────────────────────────────────

  private contextSettings(provider: ProviderConfig): ContextSettings {
    return {
      autoCompact: this.settings.autoCompact !== false,
      threshold: this.settings.compactThreshold || 0.8,
      manualMaxOutput: manualMaxOutput(this.settings, provider),
    };
  }

  private toolsFor(provider: ProviderConfig): ToolDefinition[] {
    return this.toolRegistry
      .getDefinitions()
      .filter((tool) => tool.name !== "get_note_images" || provider.supportsVision)
      .filter((tool) => tool.name !== "find_images" || provider.supportsVision);
  }

  private systemFor(profile: ModelProfile, tools: ToolDefinition[]): string {
    const base = `${this.settings.systemPrompt}\n\n${ACCESS_PROTOCOL}`;
    return !profile.nativeTools && tools.length ? base + promptToolsAddendum(tools) : base;
  }

  /** How full the window is for the conversation as it stands (and a message being typed). */
  snapshot(pendingText = "", pendingParts: MessagePart[] = []): ContextSnapshot | null {
    const provider = getActiveProvider(this.settings);
    if (!provider) return null;
    const profile = profileFor(this.settings, provider);
    const tools = this.toolsFor(provider);
    const history = pendingParts.length
      ? [...this.messages, { role: "user" as const, content: "", parts: pendingParts }]
      : this.messages;
    return this.context.snapshot({
      profile,
      system: this.systemFor(profile, tools),
      tools: profile.nativeTools ? tools : [],
      history,
      pendingText,
      settings: this.contextSettings(provider),
      reported: this.reported,
    });
  }

  /** Compacts the conversation now, whatever its size. */
  async compactNow(notice?: (n: HarnessNotice) => void): Promise<FitResult | null> {
    const provider = getActiveProvider(this.settings);
    if (!provider || !provider.apiKey || !this.messages.length) return null;
    const profile = profileFor(this.settings, provider);
    const tools = this.toolsFor(provider);
    const controller = new AbortController();
    const system: ChatMessage = { role: "system", content: this.systemFor(profile, tools) };
    const { messages } = sanitizeConversation([system, ...this.messages], { stripStaleAccessNotes: true });
    const fit = await this.context.fit({
      profile,
      conversation: messages,
      tools: profile.nativeTools ? tools : [],
      settings: this.contextSettings(provider),
      force: true,
      summarize: this.summarizer(provider, profile, controller.signal),
    });
    this.messages = fit.messages.slice(1);
    this.reported = null;
    const text = this.describeFit(fit);
    if (text) {
      this.services.log.add("compact", text);
      notice?.({ kind: "compact", text });
    }
    return fit;
  }

  private describeFit(fit: FitResult): string {
    if (!fit.actions.length) return "";
    const parts = fit.actions.map((a) => {
      switch (a.kind) {
        case "clear-tool-results": return `cleared old tool output (${a.detail ?? `${a.count} results`})`;
        case "summarize": return `summarized ${a.count} earlier messages (${a.detail ?? ""})`;
        case "drop": return `dropped ${a.count} earlier messages`;
        case "truncate": return `shortened ${a.count} long message(s)`;
      }
    });
    return `Context compacted: ${formatTokens(fit.before)} → ${formatTokens(fit.after)} tokens. ${parts.join("; ")}.`;
  }

  // ── a run ───────────────────────────────────────────────────────────────

  async run(userInput: string, cb: ChatCallbacks, parts: MessagePart[] = []): Promise<void> {
    const provider = getActiveProvider(this.settings);
    if (!provider || !provider.apiKey) {
      cb.onError(
        "No active provider or missing API key. Open Agenter settings and configure a provider."
      );
      cb.onDone();
      return;
    }

    const controller = new AbortController();
    const watcher = setInterval(() => {
      if (this.shouldAbort()) controller.abort();
    }, 100);

    const profile = profileFor(this.settings, provider);
    const tools = this.toolsFor(provider);
    const promptTools = !profile.nativeTools && tools.length > 0;
    const baseSystem = `${this.settings.systemPrompt}\n\n${ACCESS_PROTOCOL}`;
    const systemMsg: ChatMessage = { role: "system", content: this.systemFor(profile, tools) };

    const ctx: RunContext = {
      provider,
      profile,
      tools,
      sendTools: promptTools ? [] : tools,
      promptTools,
      conversation: [systemMsg, ...this.messages],
      baseSystem,
      manualMax: manualMaxOutput(this.settings, provider),
      signal: controller.signal,
      cb,
    };

    try {
      // Attachments become what this model can use: parts it can take as they are, text for the rest.
      let prepared: PreparedTurn = { content: userInput, parts, notes: [] };
      if (parts.length) {
        prepared = await prepareUserTurn({
          text: userInput,
          parts,
          profile,
          app: this.app,
          settings: this.settings,
          log: this.services.log,
          notice: (text) => cb.onNotice?.({ kind: "info", text }),
          describe: (messages, signal) => this.describeWithHelper(provider, messages, signal),
          signal: controller.signal,
          contextBudget: Math.floor(profile.contextWindow * 0.4),
        });
      }
      ctx.conversation.push({ role: "user", content: prepared.content, parts: prepared.parts });
      await this.loop(ctx);
    } catch (e: any) {
      if (!(e instanceof AbortedError) && e?.name !== "AbortError") {
        const c = classifyError(e);
        this.services.log.add("error", `${c.kind}: ${c.message.slice(0, 300)}`);
        cb.onError(explainError(c, provider.name));
      }
      this.commit(ctx);
    } finally {
      clearInterval(watcher);
    }
    cb.onDone();
  }

  /** Keeps the conversation, tidied, for the next turn. */
  private commit(ctx: RunContext): void {
    const cleaned = this.tidy(ctx.conversation.slice(1));
    this.messages = cleaned;
    if (this.reported) this.reported = { ...this.reported, historyLength: Math.min(this.reported.historyLength, cleaned.length) };
  }

  /** Joins an answer that went on in several pieces, drops the harness's own nudges, and forgets old thinking. */
  private tidy(messages: ChatMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const kind = typeof m.metadata?.kind === "string" ? (m.metadata.kind as string) : "";
      if (m.role === "user" && (kind === "continue" || kind === "nudge")) {
        continue;
      }
      const prev = out[out.length - 1];
      if (m.role === "assistant" && !m.tool_calls?.length && prev && prev.role === "assistant" && !prev.tool_calls?.length && messages[i - 1]?.metadata?.kind === "continue") {
        out[out.length - 1] = { ...prev, content: `${prev.content}${m.content}` };
        continue;
      }
      out.push({ ...m });
    }
    let lastUser = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role === "user" && typeof out[i].metadata?.kind !== "string") { lastUser = i; break; }
    }
    return out.map((m, i) => (m.reasoning && i < lastUser ? { ...m, reasoning: undefined } : m));
  }

  private emitContext(ctx: RunContext, pending = ""): void {
    if (!ctx.cb.onContext) return;
    ctx.cb.onContext(
      this.context.snapshot({
        profile: ctx.profile,
        system: ctx.conversation[0].content,
        tools: ctx.sendTools,
        history: ctx.conversation.slice(1),
        pendingText: pending,
        settings: this.contextSettings(ctx.provider),
        reported: this.reported,
      })
    );
  }

  private notice(ctx: RunContext, kind: HarnessNotice["kind"], text: string, logKind: Parameters<HarnessServices["log"]["add"]>[0]): void {
    this.services.log.add(logKind, text);
    ctx.cb.onNotice?.({ kind, text });
  }

  // ── the loop ────────────────────────────────────────────────────────────

  private async loop(ctx: RunContext): Promise<void> {
    const { cb } = ctx;
    const state = { continuations: 0, nudges: 0, malformed: 0, lastSig: "", repeat: 0, sawToolResult: false };

    // Continue until the model produces a final answer or the user stops the run.
    // Tool-heavy workflows are not cut off by an arbitrary round count; a model
    // that repeats itself is stopped by the loop guard instead.
    while (!ctx.signal.aborted) {
      // The history is put right, and made to fit, before every request.
      const san = sanitizeConversation(ctx.conversation, { stripStaleAccessNotes: true });
      if (!reportIsClean(san.report)) {
        this.services.log.add("sanitize", describeReport(san.report));
        ctx.conversation = san.messages;
      }
      await this.fit(ctx, false);
      if (ctx.signal.aborted) break;

      const turn = await this.request(ctx);
      if (!turn || ctx.signal.aborted) break;

      const { finish } = turn;
      let calls = turn.calls;
      let text = turn.text;

      // A model that wrote its call as text.
      const textCallsEnabled = this.settings.textToolCalls !== false && ctx.tools.length > 0;
      if (!calls.length && textCallsEnabled) {
        const ext = extractTextToolCalls(text, ctx.tools);
        if (ext.calls.length) {
          calls = ext.calls;
          text = ext.text;
          turn.guard.discardHeld();
          this.notice(ctx, "repair", `Read ${calls.length} tool call(s) the model wrote as text (${calls.map((c) => c.name).join(", ")}).`, "text-tool-call");
        } else {
          turn.guard.release();
        }
      } else {
        turn.guard.release();
      }

      if (turn.usage) this.recordUsage(ctx, turn.usage);

      // ── no tools: an answer, or something that is not one ────────────────
      if (calls.length === 0) {
        if (finish.reason === "length") {
          const spentThinking = !text.trim();
          if (spentThinking) {
            this.notice(ctx, "warning", "The model used its whole output limit before writing an answer (thinking can use all of it). Ask for something shorter, or lower its reasoning effort in the model settings.", "output-cut");
            ctx.conversation.push({ role: "assistant", content: text, reasoning: turn.reasoning || undefined });
            this.commit(ctx);
            return;
          }
          ctx.conversation.push({ role: "assistant", content: text, reasoning: turn.reasoning || undefined });
          if (state.continuations < MAX_CONTINUATIONS) {
            state.continuations++;
            this.notice(ctx, "info", "The answer reached the model's output limit; asking it to go on…", "continued");
            ctx.conversation.push({ role: "user", content: "Continue exactly where you stopped. Do not repeat anything and do not start over.", metadata: { kind: "continue" } });
            continue;
          }
          this.commit(ctx);
          return;
        }
        if (finish.reason === "content_filter") {
          ctx.conversation.push({ role: "assistant", content: text, reasoning: turn.reasoning || undefined });
          this.notice(ctx, "warning", "The provider's safety filter stopped this answer.", "error");
          this.commit(ctx);
          return;
        }
        if (finish.reason === "malformed" && state.malformed < MAX_NUDGES) {
          state.malformed++;
          this.notice(ctx, "repair", "The model's tool call was malformed; asking it to try again.", "repair");
          ctx.conversation.push({ role: "user", content: "Your last tool call was malformed and was not run. Call the tool again with valid JSON arguments, or answer without it.", metadata: { kind: "nudge" } });
          continue;
        }
        if (!text.trim()) {
          if (state.sawToolResult && state.nudges < MAX_NUDGES) {
            state.nudges++;
            this.services.log.add("empty", "The model answered with nothing after tool results; asking it to continue.");
            ctx.conversation.push({ role: "user", content: "Continue: use the tool results above to answer the user's request now.", metadata: { kind: "nudge" } });
            continue;
          }
          this.services.log.add("empty", "The model returned an empty answer.");
          const filler = "(The model returned an empty answer. Try again, or pick another model.)";
          cb.onAssistantToken(filler);
          ctx.conversation.push({ role: "assistant", content: filler });
          this.commit(ctx);
          return;
        }
        ctx.conversation.push({ role: "assistant", content: text, reasoning: turn.reasoning || undefined });
        this.commit(ctx);
        this.emitContext(ctx);
        return;
      }

      // ── tools ────────────────────────────────────────────────────────────
      state.continuations = 0;
      state.nudges = 0;
      const outcome = await this.runCalls(ctx, calls, text, turn, finish, state);
      if (outcome === "stop") return;
    }
    if (ctx.signal.aborted) this.commit(ctx);
  }

  /** Brings the request inside the window; says so when it had to. */
  private async fit(ctx: RunContext, force: boolean): Promise<FitResult> {
    const fit = await this.context.fit({
      profile: ctx.profile,
      conversation: ctx.conversation,
      tools: ctx.sendTools,
      settings: this.contextSettings(ctx.provider),
      force,
      summarize: this.summarizer(ctx.provider, ctx.profile, ctx.signal),
      shouldAbort: () => ctx.signal.aborted,
    });
    if (fit.actions.length) {
      ctx.conversation = fit.messages;
      this.reported = null;
      const text = this.describeFit(fit);
      this.notice(ctx, "compact", text, "compact");
    }
    this.emitContext(ctx);
    return fit;
  }

  private summarizer(provider: ProviderConfig, profile: ModelProfile, signal: AbortSignal): (old: ChatMessage[], previous?: string) => Promise<string> {
    return async (old, previous) => {
      const adapter = this.adapter(provider, profile);
      let text = "";
      let failure: Error | null = null;
      await adapter.chat(summaryRequest(old, previous), [], {
        onToken: (t) => { text += t; },
        onDone: () => {},
        onError: (e) => { failure = e; },
      }, { maxOutput: Math.min(profile.maxOutput, profile.reasoning ? 8_000 : 3_000), signal });
      if (failure) throw failure;
      return text;
    };
  }

  private adapter(provider: ProviderConfig, profile: ModelProfile, manualMax?: number): BaseProvider {
    return createProvider(provider, {
      maxTokens: manualMax ?? manualMaxOutput(this.settings, provider),
      temperature: this.settings.temperature,
      modelOptions: this.settings.modelOptions?.[`${provider.id}:${provider.model}`] ?? {},
      profile,
    });
  }

  /** An image or scanned page described by a model that can see, for one that cannot. */
  private async describeWithHelper(main: ProviderConfig, messages: ChatMessage[], signal: AbortSignal): Promise<string | null> {
    const setting = this.settings.visionHelperProviderId ?? "";
    if (setting === "off") return null;
    const candidates = this.settings.providers.filter((p) => p.apiKey && p.supportsVision && p.type !== "cloudflare" && p.id !== main.id);
    const helper = setting ? this.settings.providers.find((p) => p.id === setting && p.apiKey) : candidates[0];
    if (!helper) return null;
    const profile = profileFor(this.settings, helper);
    const adapter = this.adapter(helper, { ...profile, vision: true }, undefined);
    let text = "";
    let failure: Error | null = null;
    await adapter.chat(messages, [], {
      onToken: (t) => { text += t; },
      onDone: () => {},
      onError: (e) => { failure = e; },
    }, { maxOutput: Math.min(profile.maxOutput, 4_000), signal });
    if (failure) {
      this.services.log.add("attachment", `The vision helper (${helper.name}) failed: ${(failure as Error).message.slice(0, 200)}`);
      return null;
    }
    this.services.log.add("attachment", `Described an attachment with ${helper.name} (${helper.model}).`);
    return text.trim() || null;
  }

  // ── one request, with everything that can go wrong with it ──────────────

  private async request(ctx: RunContext): Promise<TurnResult | null> {
    let transient = 0;
    let negotiations = 0;
    let overflowFits = 0;
    for (;;) {
      if (ctx.signal.aborted) return null;
      const system = ctx.conversation[0];
      let messages = ctx.conversation;
      if (ctx.promptTools) messages = [system, ...toPromptMessages(ctx.conversation.slice(1))];
      const inputEstimate = this.context.measure(ctx.profile, system.content, ctx.sendTools, ctx.conversation.slice(1));
      const maxOutput = Math.min(requestMaxOutput(ctx.profile, inputEstimate, ctx.manualMax), ctx.outputCeiling ?? Infinity);
      this.services.log.add("request", `${ctx.profile.model}: ~${formatTokens(inputEstimate)} in, output limit ${formatTokens(maxOutput)}${ctx.promptTools ? ", tools in the prompt" : ""}`);

      const turn = await this.attempt(ctx, messages, maxOutput, inputEstimate);
      if (!turn.error) return turn.result!;

      const error = turn.error;
      const c: ClassifiedError = classifyError(error, { requestedOutput: maxOutput });
      if (c.kind === "aborted" || ctx.signal.aborted) return null;
      const shown = turn.result?.shown ?? false;

      // Temporary trouble: wait, and ask again.
      if (c.transient && this.settings.retryTransientErrors !== false && transient < MAX_ATTEMPTS_TRANSIENT) {
        transient++;
        const wait = retryDelayMs(transient, c.retryAfterMs);
        if (shown) ctx.cb.onStreamReset?.();
        this.notice(ctx, "retry", `${explainShort(c)} Trying again in ${Math.max(1, Math.round(wait / 1000))}s (${transient}/${MAX_ATTEMPTS_TRANSIENT})…`, "retry");
        await sleep(wait, ctx.signal);
        continue;
      }

      // The request itself was wrong in a way the answer explains: fix that and ask again.
      if (negotiations < MAX_NEGOTIATIONS) {
        if (c.kind === "output_limit" && c.outputLimit) {
          negotiations++;
          this.learnAbout(ctx, { maxOutput: c.outputLimit, outputSource: "learned" }, `The model's output limit is ${formatTokens(c.outputLimit)}.`);
          continue;
        }
        if (c.kind === "context_overflow") {
          negotiations++;
          // The input fits and only the room left for the answer was over-estimated: ask for a shorter answer.
          const limit = c.contextLimit ?? ctx.profile.contextWindow;
          if (c.inputTokens && c.inputTokens < limit * 0.97 && !ctx.outputCeiling) {
            const ceiling = Math.max(256, limit - c.inputTokens - Math.max(256, Math.ceil(limit * 0.03)));
            if (ceiling >= 512) {
              this.context.learnFrom(ctx.profile, this.context.rawEstimate(ctx.profile, ctx.conversation[0].content, ctx.sendTools, ctx.conversation.slice(1)), { inputTokens: c.inputTokens, outputTokens: 0 });
              if (c.contextLimit && c.contextLimit < ctx.profile.contextWindow) {
                this.learnAbout(ctx, { contextWindow: c.contextLimit, contextSource: "learned" }, `The model's window is ${formatTokens(c.contextLimit)}, not ${formatTokens(ctx.profile.contextWindow)}.`);
              }
              ctx.outputCeiling = ceiling;
              this.notice(ctx, "info", `The input uses ${formatTokens(c.inputTokens)} of the ${formatTokens(limit)} window, so this answer is limited to ${formatTokens(ceiling)}.`, "negotiated");
              continue;
            }
          }
          overflowFits++;
          if (c.contextLimit && c.contextLimit < ctx.profile.contextWindow) {
            this.learnAbout(ctx, { contextWindow: c.contextLimit, contextSource: "learned" }, `The model's window is ${formatTokens(c.contextLimit)}, not ${formatTokens(ctx.profile.contextWindow)}.`);
          }
          const before = ctx.conversation.length;
          const fit = await this.fit(ctx, true);
          if (fit.actions.length && (overflowFits <= 3)) {
            this.reported = null;
            continue;
          }
          if (ctx.conversation.length === before && !fit.actions.length) {
            throw new Error("The request does not fit the model's context window, even after compacting. Start a new chat, or shorten the message.");
          }
          continue;
        }
        if (c.kind === "unsupported_param" && c.param) {
          negotiations++;
          const handled = this.negotiateParam(ctx, c.param);
          if (handled) continue;
        }
        // Ollama: the window asked for did not load (not enough memory): ask for half.
        if (ctx.provider.type === "ollama" && /memory|out of memory|failed to load|runner process|cuda|alloc/i.test(c.message) && ctx.profile.contextWindow > 4_096) {
          negotiations++;
          const half = Math.max(4_096, Math.floor((ctx.profile.numCtx ?? ctx.profile.contextWindow) / 2));
          this.learnAbout(ctx, { numCtx: half }, `Ollama could not load that window; using ${formatTokens(half)}.`);
          continue;
        }
      }
      throw error;
    }
  }

  /** A parameter the server refused: remember it, leave it out, and say whether that was understood. */
  private negotiateParam(ctx: RunContext, param: string): boolean {
    switch (param) {
      case "temperature":
      case "top_p":
        this.learnAbout(ctx, { acceptsTemperature: false }, "This model does not accept a temperature; sending without it.");
        return true;
      case "max_tokens":
        this.learnAbout(ctx, { outputParam: "max_completion_tokens" }, "This server wants `max_completion_tokens`; switching.");
        return true;
      case "max_completion_tokens":
        this.learnAbout(ctx, { outputParam: "max_tokens" }, "This server wants `max_tokens`; switching.");
        return true;
      case "stream_options":
        this.learnAbout(ctx, { streamUsage: false }, "This server does not report token usage while streaming; the bar will estimate.");
        return true;
      case "tools": {
        if (!ctx.tools.length) return false;
        this.learnAbout(ctx, { nativeTools: false }, "This model does not take tools through the API; describing them in the prompt instead.");
        ctx.promptTools = true;
        ctx.sendTools = [];
        ctx.conversation[0] = { ...ctx.conversation[0], content: this.systemFor(ctx.profile, ctx.tools) };
        return true;
      }
      default:
        return false;
    }
  }

  private learnAbout(ctx: RunContext, patch: Parameters<typeof learn>[2], text: string): void {
    learn(this.settings, ctx.provider, patch);
    void this.services.save();
    ctx.profile = profileFor(this.settings, ctx.provider);
    this.notice(ctx, "info", text, "learned");
    this.emitContext(ctx);
  }

  /** One request to the provider, streamed to the screen. */
  private async attempt(
    ctx: RunContext,
    messages: ChatMessage[],
    maxOutput: number,
    inputEstimate: number
  ): Promise<{ result?: TurnResult; error?: unknown }> {
    const { cb } = ctx;
    const adapter = this.adapter(ctx.provider, ctx.profile, ctx.manualMax);
    let shown = false;
    const guard = new ToolCallTextGuard(
      (chunk) => {
        shown = true;
        cb.onAssistantToken(chunk);
      },
      this.settings.textToolCalls !== false && ctx.tools.length > 0
    );
    const result: TurnResult = { text: "", reasoning: "", calls: [], finish: { reason: "stop" }, shown: false, guard };
    let failure: unknown = null;
    try {
      await adapter.chat(
        messages,
        ctx.sendTools,
        {
          onToken: (t) => {
            if (ctx.signal.aborted) return;
            result.text += t;
            guard.push(t);
            if (result.text.length % 400 < t.length) this.emitContext(ctx, result.text);
          },
          onReasoning: (t) => {
            if (ctx.signal.aborted) return;
            result.reasoning += t;
            cb.onReasoningToken?.(t);
          },
          onToolCalls: (calls) => { result.calls = calls; },
          onUsage: (usage) => {
            result.usage = usage;
            this.context.learnFrom(ctx.profile, this.context.rawEstimate(ctx.profile, ctx.conversation[0].content, ctx.sendTools, ctx.conversation.slice(1)), usage);
            void inputEstimate;
          },
          onFinish: (info) => { result.finish = info; },
          onDone: () => {},
          onError: (err) => { failure = err; },
        },
        { maxOutput, signal: ctx.signal }
      );
    } catch (e) {
      failure = e;
    }
    result.shown = shown;
    if (failure) {
      // What was streamed before the failure is void: the request will be made again, or the run ends.
      return { result, error: failure };
    }
    return { result };
  }

  private recordUsage(ctx: RunContext, usage: TokenUsage): void {
    this.services.log.add("usage", `${formatTokens(usage.inputTokens)} in, ${formatTokens(usage.outputTokens)} out${usage.cachedTokens ? `, ${formatTokens(usage.cachedTokens)} cached` : ""}${usage.reasoningTokens ? `, ${formatTokens(usage.reasoningTokens)} thinking` : ""}`);
    this.reported = { usage, historyLength: ctx.conversation.length - 1 + 1 };
  }

  // ── tool calls ──────────────────────────────────────────────────────────

  private async runCalls(
    ctx: RunContext,
    rawCalls: ToolCall[],
    text: string,
    turn: TurnResult,
    finish: FinishInfo,
    state: { continuations: number; nudges: number; malformed: number; lastSig: string; repeat: number; sawToolResult: boolean }
  ): Promise<"continue" | "stop"> {
    const { cb } = ctx;
    const truncated = finish.reason === "length";

    // Names and arguments are put right first, so the history holds calls a provider will accept back.
    const calls: ToolCall[] = [];
    const problems = new Map<string, string>();
    rawCalls.forEach((raw, index) => {
      const call: ToolCall = { ...raw, id: raw.id || `call_${index + 1}` };
      const name = matchToolName(call.name, ctx.tools);
      if (!name) {
        problems.set(call.id, `Unknown tool "${call.name}". The tools are: ${ctx.tools.map((t) => t.name).join(", ")}.`);
      } else {
        call.name = name;
        const isLast = index === rawCalls.length - 1;
        const parsed = parseToolArguments(call.arguments, { allowTruncated: false });
        if (!parsed.ok) {
          problems.set(
            call.id,
            truncated && isLast
              ? "The answer reached the model's output limit while this call was being written, so it was cut off and not run. Write less in one call: for a long note, create it with a short first part, then add the rest with append_note."
              : `${parsed.error} Send the call again with valid JSON arguments that match the tool's schema.`
          );
        } else {
          if (parsed.repair !== "none") {
            this.services.log.add("repair", `Repaired the JSON arguments of ${call.name}.`);
          }
          call.arguments = JSON.stringify(parsed.args);
          const missing = missingRequired(ctx.tools.find((t) => t.name === name)!, parsed.args);
          if (missing.length) problems.set(call.id, `Missing required argument(s): ${missing.join(", ")}. Send the call again with them.`);
        }
      }
      calls.push(call);
    });

    ctx.conversation.push({
      role: "assistant",
      content: text,
      tool_calls: calls,
      reasoning: turn.reasoning || undefined,
    });

    // A model that makes the same calls again and again.
    const sig = calls.map((c) => `${c.name}\u0000${c.arguments}`).join("\u0001");
    state.repeat = sig === state.lastSig ? state.repeat + 1 : 1;
    state.lastSig = sig;
    const guardOn = this.settings.loopGuard !== false;

    const imageParts: MessagePart[] = [];
    for (const call of calls) {
      if (ctx.signal.aborted) return "stop";
      cb.onToolUse(call.name, call.arguments);

      const problem = problems.get(call.id);
      if (problem) {
        const msg = `Tool error: ${problem}`;
        cb.onToolResult(msg);
        ctx.conversation.push({ role: "tool", content: msg, tool_call_id: call.id, tool_name: call.name });
        continue;
      }

      const accessRequest = this.toolRegistry.getAccessRequest(call);
      if (accessRequest) {
        const approved = cb.onAccessRequest ? await cb.onAccessRequest(accessRequest) : false;
        if (ctx.signal.aborted) return "stop";
        if (!approved) {
          const msg = `The user denied additional ${accessRequest.requestedMode} access for "${call.name}". Continue within the current context and do not retry the same request unless the user asks.`;
          cb.onToolResult(msg);
          ctx.conversation.push({ role: "tool", content: msg, tool_call_id: call.id, tool_name: call.name });
          continue;
        }
        this.toolRegistry.grantAccess(accessRequest);

        if (call.name === "request_access") {
          const target = accessRequest.targetPath ? ` for "${accessRequest.targetPath}"` : "";
          const msg = `The user granted temporary ${accessRequest.requestedMode} access${target} for this run. Continue now with the required tools; do not restart the conversation.`;
          cb.onToolResult(msg);
          ctx.conversation.push({ role: "tool", content: msg, tool_call_id: call.id, tool_name: call.name });
          continue;
        }
      }

      // Destructive actions can never bypass confirmation. Other mutations
      // follow the user's approval settings (enabled by default).
      const alwaysConfirm = call.name === "trash_note";
      const needsApproval = alwaysConfirm || this.settings.toolApproval?.[call.name] === true;
      if (needsApproval && cb.onApprovalRequest) {
        const approved = await cb.onApprovalRequest(call);
        if (ctx.signal.aborted) return "stop";
        if (!approved) {
          const msg = `The user rejected the "${call.name}" action. Do not retry it; ask how they'd like to proceed instead.`;
          cb.onToolResult(msg);
          ctx.conversation.push({ role: "tool", content: msg, tool_call_id: call.id, tool_name: call.name });
          continue;
        }
      }

      const res = await this.toolRegistry.execute(call);
      const prepared = prepareToolOutput(call.name, res.output, { contextWindow: ctx.profile.contextWindow, vision: ctx.profile.vision });
      if (prepared.truncated) this.services.log.add("truncated", `${call.name} returned ${prepared.originalChars} characters; cut to fit the window.`);
      imageParts.push(...prepared.images);
      let content = prepared.text;
      if (guardOn && state.repeat >= REPEAT_WARN) {
        content += `\n\n[This exact call has now been made ${state.repeat} times in a row with the same result. Use what you already have, or try something different.]`;
        this.services.log.add("loop-guard", `${call.name} repeated ${state.repeat} times.`);
      }
      cb.onToolResult(content);
      ctx.conversation.push({ role: "tool", content, tool_call_id: call.id, tool_name: call.name });
      state.sawToolResult = true;
    }
    state.sawToolResult = true;

    if (imageParts.length) {
      ctx.conversation.push({ role: "user", content: "Images returned by the tools above:", parts: imageParts, metadata: { kind: "images" } });
    }

    if (guardOn && state.repeat >= REPEAT_STOP) {
      this.notice(ctx, "warning", "The model kept making the same tool call, so the run was stopped.", "loop-guard");
      cb.onError("The model kept making the same tool call. I stopped it. Try rephrasing the request, or pick another model.");
      this.commit(ctx);
      return "stop";
    }
    this.emitContext(ctx);
    return "continue";
  }
}

function explainShort(c: ClassifiedError): string {
  switch (c.kind) {
    case "rate_limit": return "The provider is limiting requests.";
    case "overloaded": return "The provider is overloaded.";
    case "server": return `The provider had a server error${c.status ? ` (${c.status})` : ""}.`;
    case "network": return "The connection dropped.";
    case "timeout": return "The provider stopped answering.";
    case "refused": return "Could not connect.";
    default: return "The request failed.";
  }
}

function missingRequired(tool: ToolDefinition, args: Record<string, unknown>): string[] {
  const schema = tool.parameters as { required?: unknown };
  const required = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
  return required.filter((key) => args[key] === undefined || args[key] === null);
}

export { INTERRUPTED_RESULT };
