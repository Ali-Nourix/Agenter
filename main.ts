import { ItemView, MarkdownView, MarkdownRenderer, Menu, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import {
  AgentSettings,
  DEFAULT_SETTINGS,
  AgentSettingTab,
  deriveTitle,
  getActiveSession,
} from "./src/settings";
import { FloatingChatPanel } from "./src/ui";
import { AgentOrchestrator, ChatCallbacks } from "./src/orchestrator";

export const AGENTER_VIEW_TYPE = "agenter-chat-view";

/** Tiny inline SVG icon helper for plugin-level UI (selection popover). */
function safeIconHtml(el: HTMLElement, icon: string) {
  const paths: Record<string, string> = {
    sparkles: '<path d="M12 3l1.7 5.2L19 10l-5.3 1.8L12 17l-1.7-5.2L5 10l5.3-1.8z"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
  };
  el.empty();
  const path = paths[icon];
  if (!path) {
    el.textContent = "•";
    return;
  }
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

class AgenterChatView extends ItemView {
  private panel: FloatingChatPanel | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: AgenterPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return AGENTER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Agenter";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("agenter-view-content");
    this.panel = new FloatingChatPanel(this.plugin, {
      mode: "docked",
      mountEl: this.contentEl,
      onRequestFloat: () => void this.plugin.openFloatingChat(),
      onRequestClose: () => void this.leaf.detach(),
    });
    this.plugin.activeChatPanel = this.panel;
  }

  async onClose(): Promise<void> {
    if (this.plugin.activeChatPanel === this.panel) {
      this.plugin.activeChatPanel = null;
    }
    this.panel?.destroy();
    this.panel = null;
    this.contentEl.removeClass("agenter-view-content");
  }
}

export default class AgenterPlugin extends Plugin {
  settings: AgentSettings;
  activeChatPanel: FloatingChatPanel | null = null;
  pendingPrompt = "";
  private floatingPanel: FloatingChatPanel | null = null;
  private selectionTimer: number | null = null;

  async onload() {
    await this.loadSettings();

    this.registerView(
      AGENTER_VIEW_TYPE,
      (leaf) => new AgenterChatView(leaf, this)
    );

    this.addRibbonIcon("message-square", "Open Agenter chat", () => {
      void this.togglePanel();
    });

    this.addCommand({
      id: "agenter-open-chat",
      name: "Open chat in right sidebar",
      callback: () => void this.openDockedChat(),
    });

    this.addCommand({
      id: "agenter-open-floating-chat",
      name: "Open floating chat",
      callback: () => void this.openFloatingChat(),
    });

    this.addCommand({
      id: "agenter-close-chat",
      name: "Close chat",
      callback: () => this.closeAllPanels(),
    });

    this.addCommand({
      id: "agenter-ai-action-on-selection",
      name: "Run AI action on selection",
      editorCallback: (editor) => {
        const sel = editor.getSelection();
        if (sel && sel.trim()) {
          this.showSelectionAI(editor, sel.trim());
        } else {
          new Notice("Select some text first.");
        }
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const sel = editor.getSelection();
        if (sel && sel.trim()) {
          menu.addItem((item) => {
            item
              .setTitle("Agenter: AI actions")
              .setIcon("sparkles")
              .onClick(() => this.showSelectionAI(editor, sel.trim()));
          });
        }
      })
    );

    // Contextual AI: automatically appear next to a completed text selection.
    this.registerDomEvent(document, "mouseup", (event: MouseEvent) => {
      this.scheduleSelectionAI(event);
    });
    this.registerDomEvent(document, "keyup", (event: KeyboardEvent) => {
      if (event.shiftKey || event.key === "ContextMenu") this.scheduleSelectionAI(event);
    });

    this.addSettingTab(new AgentSettingTab(this.app, this));
  }

  onunload() {
    this.closeFloatingPanel();
  }

  async togglePanel() {
    if (this.floatingPanel) {
      this.closeFloatingPanel();
      return;
    }

    const leaves = this.app.workspace.getLeavesOfType(AGENTER_VIEW_TYPE);
    if (leaves.length) {
      this.app.workspace.detachLeavesOfType(AGENTER_VIEW_TYPE);
      return;
    }

    await this.openDockedChat();
  }

  async openDockedChat() {
    this.closeFloatingPanel();

    let leaf: WorkspaceLeaf | null =
      this.app.workspace.getLeavesOfType(AGENTER_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice("Agenter could not open the right sidebar.");
        return;
      }
      await leaf.setViewState({ type: AGENTER_VIEW_TYPE, active: true });
    }

    await this.app.workspace.revealLeaf(leaf);
  }

  async openFloatingChat(position?: { x: number; y: number }) {
    this.app.workspace.detachLeavesOfType(AGENTER_VIEW_TYPE);
    if (!this.floatingPanel) {
      this.floatingPanel = new FloatingChatPanel(this, {
        mode: "floating",
        onRequestDock: () => void this.openDockedChat(),
        onRequestClose: () => this.closeFloatingPanel(),
      });
      this.activeChatPanel = this.floatingPanel;
    }
    if (position) this.floatingPanel.moveNear(position.x, position.y);
  }

  closeFloatingPanel() {
    const panel = this.floatingPanel;
    this.floatingPanel = null;
    if (this.activeChatPanel === panel) this.activeChatPanel = null;
    panel?.destroy();
  }

  closeAllPanels() {
    this.closeFloatingPanel();
    this.app.workspace.detachLeavesOfType(AGENTER_VIEW_TYPE);
  }

  private scheduleSelectionAI(event: MouseEvent | KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (target?.closest?.(".agenter-root, .agenter-selection-popover, .menu, .modal-container")) return;
    if (this.selectionTimer !== null) window.clearTimeout(this.selectionTimer);
    this.selectionTimer = window.setTimeout(() => {
      this.selectionTimer = null;
      const view = this.app.workspace.getActiveViewOfType(MarkdownView) as any;
      const editor = view?.editor;
      const selection = editor?.getSelection?.()?.trim?.() ?? "";
      if (!selection) {
        document.querySelector(".agenter-selection-popover")?.remove();
        return;
      }
      const cursor = editor.cursorCoords?.("to") ?? editor.cursorCoords?.();
      const point = {
        x: cursor?.left ?? (event instanceof MouseEvent ? event.clientX : window.innerWidth / 2),
        y: cursor?.bottom ?? (event instanceof MouseEvent ? event.clientY : window.innerHeight / 2),
      };
      this.showSelectionAI(editor, selection, point);
    }, 90);
  }

  /** Contextual third chat mode: compact, selection-anchored, and self-contained. */
  showSelectionAI(
    editor: any,
    selection: string,
    point?: { x: number; y: number }
  ) {
    const cursor = editor.cursorCoords ? editor.cursorCoords("to") : null;
    const x = point?.x ?? cursor?.left ?? window.innerWidth / 2;
    const y = point?.y ?? cursor?.bottom ?? window.innerHeight / 2;
    document.querySelector(".agenter-selection-popover")?.remove();

    const popover = document.createElement("div");
    popover.addClass("agenter-selection-popover", "is-contextual");
    const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";

    const renderMd = (text: string, target: HTMLElement) => {
      target.empty();
      target.addClass("markdown-rendered");
      target.dir = /[\u0590-\u08FF]/.test(text) ? "rtl" : "ltr";
      MarkdownRenderer.render(this.app, text, target, sourcePath, this).catch(() => {
        target.setText(text);
      });
    };

    const position = () => {
      const rect = popover.getBoundingClientRect();
      const left = Math.max(8, Math.min(x + 7, window.innerWidth - rect.width - 8));
      let top = y + 7;
      if (top + rect.height > window.innerHeight - 8) top = Math.max(8, y - rect.height - 7);
      popover.style.left = `${left}px`;
      popover.style.top = `${top}px`;
    };

    const head = document.createElement("div");
    head.addClass("agenter-selection-popover-head");
    const brand = document.createElement("span");
    brand.addClass("agenter-selection-brand");
    safeIconHtml(brand, "sparkles");
    const title = document.createElement("span");
    title.textContent = "Agenter";
    head.append(brand, title);
    const openMainBtn = document.createElement("button");
    openMainBtn.addClass("agenter-selection-open-main");
    openMainBtn.textContent = "Main panel";
    openMainBtn.setAttribute("aria-label", "Continue this chat in the main panel");
    openMainBtn.addEventListener("click", () => void openInMain());
    head.appendChild(openMainBtn);
    const closeBtn = document.createElement("button");
    closeBtn.addClass("agenter-selection-popover-close");
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Close contextual chat");
    closeBtn.addEventListener("click", () => popover.remove());
    head.appendChild(closeBtn);
    popover.appendChild(head);

    // Real Obsidian markdown preview in an expandable context capsule.
    const previewShell = document.createElement("section");
    previewShell.addClass("agenter-selection-preview-shell");
    const previewTop = document.createElement("button");
    previewTop.addClass("agenter-selection-preview-top");
    const contextLabel = document.createElement("span");
    contextLabel.textContent = `Selection · ${selection.split("\n").length} lines`;
    const expandLabel = document.createElement("span");
    expandLabel.textContent = "Show full";
    previewTop.append(contextLabel, expandLabel);
    const preview = document.createElement("div");
    preview.addClass("agenter-selection-preview", "markdown-rendered");
    renderMd(selection, preview);
    previewShell.append(previewTop, preview);
    previewTop.addEventListener("click", () => {
      const expanded = !previewShell.hasClass("is-expanded");
      previewShell.toggleClass("is-expanded", expanded);
      expandLabel.textContent = expanded ? "Collapse" : "Show full";
      window.requestAnimationFrame(position);
    });
    popover.appendChild(previewShell);

    // Inline conversation log: hidden until Chat here / a prompt / a question is used.
    const chatLog = document.createElement("div");
    chatLog.addClass("agenter-selection-chat-log");
    popover.appendChild(chatLog);

    const actionRow = document.createElement("div");
    actionRow.addClass("agenter-selection-primary-actions");
    const insert = document.createElement("button");
    insert.textContent = "Insert in chat";
    insert.addEventListener("click", async () => {
      popover.remove();
      await this.ensureChatOpen();
      this.activeChatPanel?.insertPromptFromOutside(selection);
    });
    const chatHere = document.createElement("button");
    chatHere.addClass("is-primary");
    chatHere.textContent = "Chat here";
    actionRow.append(insert, chatHere);
    popover.appendChild(actionRow);

    const prompts = this.settings.customPrompts ?? {};
    const list = document.createElement("div");
    list.addClass("agenter-selection-actions");
    popover.appendChild(list);

    const composer = document.createElement("div");
    composer.addClass("agenter-selection-composer");
    const input = document.createElement("textarea");
    input.rows = 1;
    input.placeholder = "Ask about selection…";
    const send = document.createElement("button");
    send.setAttribute("aria-label", "Send in contextual chat");
    send.textContent = "↑";
    composer.append(input, send);
    popover.appendChild(composer);

    const orchestrator = new AgentOrchestrator(this.app, this.settings);
    const session = getActiveSession(this.settings);
    // Unified history: continue the same conversation as the main panel
    // instead of starting from an empty context.
    orchestrator.setMessages(
      session.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
    );
    const persistToSession = async () => {
      const stored: any[] = [];
      for (const m of orchestrator.messages) {
        if (m.role === "user") stored.push({ role: "user", content: m.content ?? "" });
        else if (m.role === "assistant" && (m.content ?? "").trim())
          stored.push({ role: "assistant", content: m.content });
        else if (m.role === "tool")
          stored.push({ role: "tool", content: m.content ?? "", toolName: (m as any).tool_name });
      }
      if (!stored.length) return;
      session.messages = stored.slice(-200);
      session.updatedAt = Date.now();
      if (session.title === "New chat") session.title = deriveTitle(session.messages);
      await this.saveSettings();
      this.activeChatPanel?.reloadActiveSession();
    };
    const openInMain = async () => {
      await persistToSession();
      popover.remove();
      await this.ensureChatOpen();
      this.activeChatPanel?.reloadActiveSession();
    };
    let busy = false;
    let hasSelectionContext = false;
    let hydrated = false;

    const enterChatMode = () => {
      popover.addClass("is-chatting");
      chatHere.textContent = "In-place chat";
      input.placeholder = "Continue here…";
      if (!hydrated) {
        hydrated = true;
        for (const m of session.messages) {
          if (m.role === "user") appendBubble("user", m.content);
          else if (m.role === "assistant" && (m.content ?? "").trim())
            appendBubble("assistant", m.content);
        }
      }
      window.requestAnimationFrame(() => { position(); input.focus(); });
    };

    const appendBubble = (role: "user" | "assistant" | "status", text: string) => {
      const bubble = document.createElement("div");
      bubble.addClass("agenter-selection-chat-message", `is-${role}`);
      if (role === "status") bubble.setText(text);
      else renderMd(text, bubble);
      chatLog.appendChild(bubble);
      chatLog.scrollTop = chatLog.scrollHeight;
      return bubble;
    };

    const requestInlineApproval = (call: { name: string; arguments: string }): Promise<boolean> =>
      new Promise((resolve) => {
        let a: any = {};
        try { a = JSON.parse(call.arguments || "{}"); } catch { /* ignore */ }
        const card = document.createElement("div");
        card.addClass("agenter-selection-approval");
        const destructive = call.name === "trash_note";
        if (destructive) card.addClass("is-destructive");
        const lbl = document.createElement("div");
        lbl.addClass("agenter-selection-approval-label");
        const verb = call.name.replace(/[-_]/g, " ");
        lbl.textContent = a.path ? `${verb}: ${a.path}` : verb;
        card.appendChild(lbl);
        const row = document.createElement("div");
        row.addClass("agenter-selection-approval-actions");
        const reject = document.createElement("button");
        reject.textContent = "Reject";
        const approve = document.createElement("button");
        approve.addClass("is-primary");
        approve.textContent = destructive ? "Review deletion" : "Approve";
        row.append(reject, approve);
        card.appendChild(row);
        chatLog.appendChild(card);
        chatLog.scrollTop = chatLog.scrollHeight;
        window.requestAnimationFrame(position);
        const settle = (ok: boolean) => {
          row.remove();
          const st = document.createElement("div");
          st.addClass("agenter-selection-approval-status");
          st.textContent = ok ? "✓ Approved" : "✕ Rejected";
          card.appendChild(st);
          resolve(ok);
        };
        let armed = false;
        let armTimer: number | null = null;
        approve.addEventListener("click", () => {
          if (!destructive) { settle(true); return; }
          if (!armed) {
            armed = true;
            approve.textContent = "Click again: Move to Trash";
            armTimer = window.setTimeout(() => { armed = false; approve.textContent = "Review deletion"; }, 6000);
            return;
          }
          if (armTimer !== null) window.clearTimeout(armTimer);
          settle(true);
        });
        reject.addEventListener("click", () => settle(false));
      });

    const runInline = async (question: string) => {
      const clean = question.trim();
      if (!clean || busy) return;
      enterChatMode();
      busy = true;
      send.disabled = true;
      input.value = "";
      appendBubble("user", clean);
      const typing = appendBubble("status", "Thinking…");
      let response = "";
      let responseEl: HTMLElement | null = null;
      let renderTimer: number | null = null;
      const alreadyHasContext = clean.includes(selection);
      const prompt = hasSelectionContext || alreadyHasContext
        ? clean
        : `${clean}\n\n<selected-text>\n${selection}\n</selected-text>`;
      hasSelectionContext = true;
      orchestrator.shouldAbort = () => !document.body.contains(popover);

      const flush = () => {
        if (!responseEl) return;
        renderMd(response, responseEl);
        chatLog.scrollTop = chatLog.scrollHeight;
      };
      const callbacks: ChatCallbacks = {
        onAssistantToken: (token) => {
          if (typing.parentNode) typing.remove();
          if (!responseEl) responseEl = appendBubble("assistant", "");
          response += token;
          if (renderTimer === null) {
            renderTimer = window.setTimeout(() => {
              renderTimer = null;
              flush();
            }, 70);
          }
        },
        onToolUse: (name) => {
          if (typing.parentNode) typing.remove();
          appendBubble("status", `Using ${name}…`);
        },
        onToolResult: () => {},
        // Tool calls now work here too: read-only tools run automatically and
        // mutating tools show an inline Approve / Reject card.
        onApprovalRequest: (call) => requestInlineApproval(call),
        onError: (error) => {
          if (typing.parentNode) typing.remove();
          appendBubble("status", `Error: ${error}`);
        },
        onDone: () => {
          if (renderTimer !== null) window.clearTimeout(renderTimer);
          if (typing.parentNode) typing.remove();
          flush();
          busy = false;
          send.disabled = false;
          input.focus();
          void persistToSession();
          window.requestAnimationFrame(position);
        },
      };
      await orchestrator.run(prompt, callbacks);
    };

    Object.entries(prompts).slice(0, 6).forEach(([key, template]) => {
      const btn = document.createElement("button");
      btn.addClass("agenter-selection-action");
      btn.textContent = key.replace(/[-_]/g, " ");
      btn.title = String(template);
      btn.addEventListener("click", () => {
        const tmpl = String(template);
        const filled = tmpl.includes("{{selection}}")
          ? tmpl.replace(/\{\{\s*selection\s*\}\}/g, selection)
          : tmpl;
        void runInline(filled);
      });
      list.appendChild(btn);
    });

    chatHere.addEventListener("click", () => enterChatMode());
    const submit = () => void runInline(input.value);
    send.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    });

    document.body.appendChild(popover);
    position();

    const onDown = (ev: MouseEvent) => {
      if (!popover.contains(ev.target as Node)) {
        popover.remove();
        document.removeEventListener("mousedown", onDown, true);
      }
    };
    window.setTimeout(() => document.addEventListener("mousedown", onDown, true), 0);
  }

  async ensureChatOpen(): Promise<void> {
    if (this.activeChatPanel) return;
    await this.openDockedChat();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.providers) this.settings.providers = DEFAULT_SETTINGS.providers;
    if (!this.settings.activeProviderId && this.settings.providers.length) {
      this.settings.activeProviderId = this.settings.providers[0].id;
    }
    if (!Array.isArray(this.settings.chatHistory)) this.settings.chatHistory = [];
    if (!this.settings.toolApproval) {
      this.settings.toolApproval = { ...DEFAULT_SETTINGS.toolApproval };
    }
    if (!Array.isArray(this.settings.sessions)) this.settings.sessions = [];
    if (!this.settings.customPrompts) {
      this.settings.customPrompts = { ...DEFAULT_SETTINGS.customPrompts };
    }

    if (this.settings.chatHistory.length && !this.settings.sessions.length) {
      const now = Date.now();
      this.settings.sessions.push({
        id: `s-${now.toString(36)}-legacy`,
        title: deriveTitle(this.settings.chatHistory),
        createdAt: now,
        updatedAt: now,
        messages: this.settings.chatHistory,
      });
      this.settings.chatHistory = [];
    }

    getActiveSession(this.settings);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
