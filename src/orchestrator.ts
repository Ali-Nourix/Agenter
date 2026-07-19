import { App } from "obsidian";
import { AgentSettings, getActiveProvider } from "./settings";
import { createProvider, ChatMessage, ToolDefinition, ToolCall } from "./api";
import { ToolRegistry, VaultAccessRequest, VaultAccessScope } from "./tools";

export interface ChatCallbacks {
  onAssistantToken: (token: string) => void;
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
}

/**
 * Drives a single conversation: sends messages to the active provider,
 * executes any tool calls the model requests, feeds results back, and
 * repeats until the model produces a final (tool-free) answer or the
 * web_search tool is triggered (model re-runs with native search).
 *
 * Supports cooperative aborting via shouldAbort().
 */
export class AgentOrchestrator {
  private app: App;
  private settings: AgentSettings;
  private toolRegistry: ToolRegistry;
  public messages: ChatMessage[] = [];
  public shouldAbort: () => boolean = () => false;

  constructor(app: App, settings: AgentSettings) {
    this.app = app;
    this.settings = settings;
    this.toolRegistry = new ToolRegistry(app);
  }

  setMessages(messages: ChatMessage[]) {
    this.messages = messages;
  }

  setAccessScope(scope: VaultAccessScope): void {
    this.toolRegistry.setAccessScope(scope);
  }

  async run(userInput: string, cb: ChatCallbacks): Promise<void> {
    const provider = getActiveProvider(this.settings);
    if (!provider || !provider.apiKey) {
      cb.onError(
        "No active provider or missing API key. Open Agenter settings and configure a provider."
      );
      cb.onDone();
      return;
    }

    const accessProtocol = [
      "Access protocol:",
      "- You can request temporary note, folder, or vault access with request_access.",
      "- If the user asks you to get access, call request_access immediately; never say you cannot request it.",
      "- If the task needs context outside the initial scope, request the smallest sufficient scope proactively.",
      "- After approval, continue the same run and call the relevant read/list/search tool.",
      "- A denied request is not a failed session; continue within the available context.",
    ].join("\n");
    const systemMsg: ChatMessage = {
      role: "system",
      content: `${this.settings.systemPrompt}\n\n${accessProtocol}`,
    };

    const conversation: ChatMessage[] = [
      systemMsg,
      ...this.messages,
      { role: "user", content: userInput },
    ];

    const tools = this.toolRegistry
      .getDefinitions()
      .filter((tool) => tool.name !== "get_note_images" || provider.supportsVision)
      .filter((tool) => tool.name !== "find_images" || provider.supportsVision);
    const adapter = createProvider(provider, {
      maxTokens: this.settings.maxTokens,
      temperature: this.settings.temperature,
    });

    try {
      await this.loop(adapter, tools, conversation, cb);
    } catch (e: any) {
      cb.onError(e?.message ?? String(e));
    }
    cb.onDone();
  }

  private async loop(
    adapter: ReturnType<typeof createProvider>,
    tools: ToolDefinition[],
    conversation: ChatMessage[],
    cb: ChatCallbacks
  ): Promise<void> {
    for (let round = 0; round < 6; round++) {
      if (this.shouldAbort()) return;

      let assistantText = "";
      let toolCalls: ToolCall[] = [];

      await adapter.chat(conversation, tools, {
        onToken: (t) => {
          if (this.shouldAbort()) return;
          assistantText += t;
          cb.onAssistantToken(t);
        },
        onToolCalls: (calls) => {
          toolCalls = calls;
        },
        onDone: () => {},
        onError: (err) => {
          throw err;
        },
      });

      if (this.shouldAbort()) return;

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: assistantText,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      };

      const webSearchRequested = false;
      conversation.push(assistantMsg);

      if (toolCalls.length === 0) {
        this.messages = conversation.slice(1);
        return;
      }

      // web_search now runs like any other tool — the real search result is
      // returned to the model via the standard tool-result message below.

      for (const call of toolCalls) {
        if (this.shouldAbort()) return;
        cb.onToolUse(call.name, call.arguments);

        const accessRequest = this.toolRegistry.getAccessRequest(call);
        if (accessRequest) {
          const approved = cb.onAccessRequest
            ? await cb.onAccessRequest(accessRequest)
            : false;
          if (this.shouldAbort()) return;
          if (!approved) {
            const msg = `The user denied additional ${accessRequest.requestedMode} access for "${call.name}". Continue within the current context and do not retry the same request unless the user asks.`;
            cb.onToolResult(msg);
            conversation.push({
              role: "tool",
              content: msg,
              tool_call_id: call.id,
              tool_name: call.name,
            });
            continue;
          }
          this.toolRegistry.grantAccess(accessRequest);

          if (call.name === "request_access") {
            const target = accessRequest.targetPath ? ` for "${accessRequest.targetPath}"` : "";
            const msg = `The user granted temporary ${accessRequest.requestedMode} access${target} for this run. Continue now with the required tools; do not restart the conversation.`;
            cb.onToolResult(msg);
            conversation.push({
              role: "tool",
              content: msg,
              tool_call_id: call.id,
              tool_name: call.name,
            });
            continue;
          }
        }

        // Destructive actions can never bypass confirmation. Other mutations
        // follow the user's approval settings (enabled by default).
        const alwaysConfirm = call.name === "trash_note";
        const needsApproval = alwaysConfirm || this.settings.toolApproval?.[call.name] === true;
        if (needsApproval && cb.onApprovalRequest) {
          const approved = await cb.onApprovalRequest(call);
          if (this.shouldAbort()) return;
          if (!approved) {
            const msg = `The user rejected the "${call.name}" action. Do not retry it; ask how they'd like to proceed instead.`;
            cb.onToolResult(msg);
            conversation.push({
              role: "tool",
              content: msg,
              tool_call_id: call.id,
            });
            continue;
          }
        }

        const res = await this.toolRegistry.execute(call);
        cb.onToolResult(res.output);
        conversation.push({
          role: "tool",
          content: res.output,
          tool_call_id: res.callId,
          tool_name: call.name,
        });
      }
    }

    cb.onError("Reached maximum tool-call rounds without a final answer.");
  }
}
