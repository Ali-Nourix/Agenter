import {
  App,
  Notice,
  Menu,
  MarkdownView,
  MarkdownRenderer,
  Component,
} from "obsidian";
import AgenterPlugin from "../main";
import { AgentOrchestrator, ChatCallbacks } from "./orchestrator";
import { ChatMessage, ToolCall } from "./api";
import {
  getActiveProvider,
  StoredMessage,
  ChatSession,
  getActiveSession,
  genId,
  deriveTitle,
} from "./settings";
import { probeModels } from "./api";

type Scope = "note" | "folder" | "vault" | "none";
type Mode = "docked" | "floating";

export interface FloatingChatPanelOptions {
  mode?: Mode;
  mountEl?: HTMLElement;
  onRequestFloat?: () => void;
  onRequestDock?: () => void;
  onRequestClose?: () => void;
}

/** Human-readable, RTL-friendly labels for the tool-approval cards.
 *  Icons below are all confirmed-present in Obsidian's bundled Lucide
 *  icon set, so setIcon() always renders something. */
const TOOL_LABELS: Record<string, { icon: string; verb: string }> = {
  write_note: { icon: "file-plus", verb: "Create / overwrite note" },
  edit_note: { icon: "pencil", verb: "Edit note" },
  append_note: { icon: "plus", verb: "Append to note" },
  read_note: { icon: "file-text", verb: "Read note" },
  search_notes: { icon: "search", verb: "Search vault" },
  list_notes: { icon: "folder", verb: "List notes" },
  summarize_note: { icon: "align-left", verb: "Summarize note" },
  get_note_images: { icon: "image", verb: "Read note images" },
  web_search: { icon: "globe", verb: "Web search" },
  current_note: { icon: "file", verb: "Read current note" },
  list_plugins: { icon: "wrench", verb: "List plugins" },
  plugin_info: { icon: "info", verb: "Plugin info" },
  fetch_url: { icon: "external-link", verb: "Fetch URL" },
  find_images: { icon: "image", verb: "Find images" },
  read_note_section: { icon: "align-left", verb: "Read note section" },
  note_metadata: { icon: "info", verb: "Read note metadata" },
  note_links: { icon: "external-link", verb: "Inspect note links" },
  list_folders: { icon: "folder", verb: "List folders" },
  create_folder: { icon: "folder", verb: "Create folder" },
  move_note: { icon: "file", verb: "Move / rename note" },
  trash_note: { icon: "trash", verb: "Move note to Trash" },
};

/**
 * Floating / dockable chat panel for Agenter.
 *
 * Features:
 *  - A collapsible session sidebar (chat history) — create / switch /
 *    rename / delete named conversations, persisted in settings.
 *  - Inline tool-approval "action cards": when the model wants to run a
 *    mutating tool (append/edit/write), the panel shows a preview with
 *    Approve / Reject buttons before anything touches the vault.
 *  - Obsidian-native markdown rendering for assistant messages.
 *  - Docked (right sidebar) and floating (draggable window) modes.
 */
export class FloatingChatPanel {
  private plugin: AgenterPlugin;
  private app: App;
  private component: Component;
  private options: FloatingChatPanelOptions;

  private rootEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private sidebarEl!: HTMLElement;
  private chatEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private providerBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private statusIconEl!: HTMLElement;
  private statusTextEl!: HTMLElement;
  private statusMetaEl!: HTMLElement;

  private orchestrator: AgentOrchestrator;
  private messages: ChatMessage[] = [];
  private busy = false;
  private aborted = false;
  private pos = { x: 120, y: 120 };
  private scope: Scope;
  private mode: Mode;
  private minimized = false;
  private sidebarOpen = false;
  private streamBuf = "";
  private streamEl: HTMLElement | null = null;
  private streamRenderTimer: number | null = null;
  private sidebarListEl: HTMLElement | null = null;
  private pendingTool: string | null = null;
  private startedAt = 0;
  private statusTimer: number | null = null;
  private statusResetTimer: number | null = null;
  private hadError = false;
  private destroyed = false;

  constructor(plugin: AgenterPlugin, options: FloatingChatPanelOptions = {}) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.options = options;
    this.component = new Component();
    this.component.load();
    this.scope = plugin.settings.defaultContextScope;
    this.mode = options.mode ?? "floating";
    this.orchestrator = new AgentOrchestrator(this.app, plugin.settings);
    this.build();
    this.loadActiveSession();
  }

  // ================================================================ build
  private build() {
    const root = document.createElement("div");
    root.addClass("agenter-root");
    root.setAttribute("aria-label", "Agenter chat");
    this.rootEl = root;

    this.buildHeader(root);
    this.buildStatus(root);

    // Body = sidebar + chat column.
    const body = document.createElement("div");
    body.addClass("agenter-body");
    this.bodyEl = body;
    root.appendChild(body);

    this.buildSidebar(body);

    const chat = document.createElement("div");
    chat.addClass("agenter-chat");
    this.chatEl = chat;
    body.appendChild(chat);

    this.buildMessages(chat);
    this.buildInput(chat);

    if (this.sidebarOpen) root.addClass("is-sidebar-open");

    if (this.mode === "docked") this.mountDocked();
    else this.mountFloating();
  }

  private mountDocked() {
    this.rootEl.addClass("is-docked");
    this.rootEl.removeClass("is-floating");
    this.rootEl.addClass("is-native-view");
    const mountEl = this.options.mountEl ?? document.body;
    mountEl.appendChild(this.rootEl);
  }

  private mountFloating() {
    this.rootEl.addClass("is-floating");
    this.rootEl.removeClass("is-docked", "is-native-view");
    const s = this.rootEl.style;
    s.position = "fixed";
    s.zIndex = "9999";
    s.left = `${this.pos.x}px`;
    s.top = `${this.pos.y}px`;
    s.width = `${this.plugin.settings.panelWidth}px`;
    s.height = this.minimized ? "auto" : `${this.plugin.settings.panelHeight}px`;
    document.body.appendChild(this.rootEl);
    this.makeDraggable(this.rootEl.querySelector(".agenter-header") as HTMLElement);
  }

  // ------------------------------------------------------------- header
  private buildHeader(root: HTMLElement) {
    const header = document.createElement("div");
    header.addClass("agenter-header");

    const left = document.createElement("div");
    left.addClass("agenter-header-left");

    const hamburger = mkIconBtn("menu", "Toggle chat history", () =>
      this.toggleSidebar()
    );
    hamburger.addClass("agenter-hamburger");
    left.appendChild(hamburger);

    const brand = document.createElement("div");
    brand.addClass("agenter-brand");
    const dot = document.createElement("span");
    dot.addClass("agenter-dot");
    safeIcon(dot, "sparkles");
    brand.appendChild(dot);
    const titleWrap = document.createElement("div");
    titleWrap.addClass("agenter-title-wrap");
    const title = document.createElement("div");
    title.addClass("agenter-title");
    title.textContent = "Agenter";
    const sub = document.createElement("div");
    sub.addClass("agenter-subtitle");
    sub.textContent = "Obsidian command agent";
    titleWrap.appendChild(title);
    titleWrap.appendChild(sub);
    brand.appendChild(titleWrap);
    left.appendChild(brand);

    // The model/provider selector now lives at the bottom of the composer
    // (see buildInput), so it is no longer created in the header.
    header.appendChild(left);

    const controls = document.createElement("div");
    controls.addClass("agenter-controls");

    const stopBtn = mkIconBtn("square", "Stop generating", () => this.abort());
    stopBtn.addClass("agenter-stop");
    stopBtn.style.display = "none";
    const newBtn = mkIconBtn("plus", "New chat", () => this.newSession());
    const floatBtn = mkIconBtn(
      this.mode === "docked" ? "maximize-2" : "panel-right",
      this.mode === "docked" ? "Open as floating window" : "Dock in right sidebar",
      () => this.toggleMode()
    );
    const minBtn = mkIconBtn("minus", "Minimize", () => this.toggleMinimize());
    const closeBtn = mkIconBtn("x", "Close", () => this.close());

    controls.appendChild(stopBtn);
    controls.appendChild(newBtn);
    controls.appendChild(floatBtn);
    if (this.mode === "floating") controls.appendChild(minBtn);
    controls.appendChild(closeBtn);
    header.appendChild(controls);
    (header as any)._stopBtn = stopBtn;
    root.appendChild(header);
  }

  private buildStatus(root: HTMLElement) {
    const status = document.createElement("div");
    status.addClass("agenter-status", "is-idle");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    const icon = document.createElement("span");
    icon.addClass("agenter-status-icon");
    safeIcon(icon, "circle-check", "✓");
    status.appendChild(icon);
    this.statusIconEl = icon;

    const text = document.createElement("span");
    text.addClass("agenter-status-text");
    text.textContent = "Ready";
    status.appendChild(text);
    this.statusTextEl = text;

    const meta = document.createElement("span");
    meta.addClass("agenter-status-meta");
    status.appendChild(meta);
    this.statusMetaEl = meta;

    root.appendChild(status);
    this.statusEl = status;
  }

  // ------------------------------------------------------------ sidebar
  private buildSidebar(body: HTMLElement) {
    const sidebar = document.createElement("div");
    sidebar.addClass("agenter-sidebar");
    this.sidebarEl = sidebar;

    const head = document.createElement("div");
    head.addClass("agenter-sidebar-head");
    const title = document.createElement("span");
    title.textContent = "Chat history";
    head.appendChild(title);
    const newBtn = mkIconBtn("plus", "New chat", () => this.newSession());
    newBtn.addClass("agenter-sidebar-new");
    head.appendChild(newBtn);
    sidebar.appendChild(head);

    const list = document.createElement("div");
    list.addClass("agenter-session-list");
    sidebar.appendChild(list);

    const backdrop = document.createElement("div");
    backdrop.addClass("agenter-sidebar-backdrop");
    backdrop.addEventListener("click", () => this.toggleSidebar());
    body.appendChild(backdrop);
    body.appendChild(sidebar);
    this.renderSessionList();
  }

  private renderSessionList() {
    const list = this.sidebarEl.querySelector(".agenter-session-list") as HTMLElement;
    if (!list) return;
    list.empty();

    const sessions = [...this.plugin.settings.sessions].sort(
      (a, b) => b.updatedAt - a.updatedAt
    );
    const activeId = this.plugin.settings.activeSessionId;

    if (!sessions.length) {
      const empty = document.createElement("div");
      empty.addClass("agenter-session-empty");
      empty.textContent = "No conversations yet.";
      list.appendChild(empty);
      return;
    }

    for (const session of sessions) {
      const item = document.createElement("div");
      item.addClass("agenter-session-item");
      if (session.id === activeId) item.addClass("is-active");

      const label = document.createElement("div");
      label.addClass("agenter-session-label");
      const t = document.createElement("div");
      t.addClass("agenter-session-title");
      t.textContent = session.title || "New chat";
      const meta = document.createElement("div");
      meta.addClass("agenter-session-meta");
      meta.textContent = `${session.messages.filter((m) => m.role === "user" || m.role === "assistant").length} messages`;
      label.appendChild(t);
      label.appendChild(meta);
      item.appendChild(label);

      label.addEventListener("click", () => this.switchSession(session.id));

      const actions = document.createElement("div");
      actions.addClass("agenter-session-actions");
      const renameBtn = mkIconBtn("pencil", "Rename", (e) => {
        e?.stopPropagation();
        this.renameSession(session);
      });
      const delBtn = mkIconBtn("trash", "Delete", (e) => {
        e?.stopPropagation();
        this.deleteSession(session.id);
      });
      actions.appendChild(renameBtn);
      actions.appendChild(delBtn);
      item.appendChild(actions);

      list.appendChild(item);
    }
  }

  private toggleSidebar() {
    this.sidebarOpen = !this.sidebarOpen;
    this.rootEl.toggleClass("is-sidebar-open", this.sidebarOpen);
  }

  // -------------------------------------------------------- session ops
  private currentSession(): ChatSession {
    return getActiveSession(this.plugin.settings);
  }

  private async newSession() {
    // Persist whatever is on screen into the current session first.
    await this.persist();
    const session: ChatSession = {
      id: genId(),
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    this.plugin.settings.sessions.unshift(session);
    this.plugin.settings.activeSessionId = session.id;
    await this.plugin.saveSettings();
    this.messages = [];
    this.renderSessionList();
    this.messagesEl.empty();
    this.addWelcome();
    this.inputEl?.focus();
  }

  private async switchSession(id: string) {
    if (id === this.plugin.settings.activeSessionId) {
      this.toggleSidebar();
      return;
    }
    await this.persist();
    this.plugin.settings.activeSessionId = id;
    await this.plugin.saveSettings();
    this.loadActiveSession();
    this.renderSessionList();
    if (this.sidebarOpen) this.toggleSidebar();
  }

  private renameSession(session: ChatSession) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = session.title;
    input.addClass("agenter-rename-input");

    const item = this.sidebarEl.querySelector(".agenter-session-item.is-active") ??
      Array.from(this.sidebarEl.querySelectorAll(".agenter-session-item")).find(
        (el) => (el.querySelector(".agenter-session-title") as HTMLElement)?.textContent === session.title
      );

    const commit = async () => {
      const v = input.value.trim();
      if (v) {
        session.title = v;
        session.updatedAt = Date.now();
        await this.plugin.saveSettings();
      }
      this.renderSessionList();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") this.renderSessionList();
    });
    input.addEventListener("blur", commit);

    if (item) {
      const label = item.querySelector(".agenter-session-label") as HTMLElement;
      label.empty();
      label.appendChild(input);
      input.focus();
      input.select();
    }
  }

  private async deleteSession(id: string) {
    const sessions = this.plugin.settings.sessions;
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    sessions.splice(idx, 1);
    if (this.plugin.settings.activeSessionId === id) {
      this.plugin.settings.activeSessionId = sessions[0]?.id ?? "";
      getActiveSession(this.plugin.settings); // recreates one if empty
      this.loadActiveSession();
    }
    await this.plugin.saveSettings();
    this.renderSessionList();
  }

  // ----------------------------------------------------------- messages
  private buildMessages(root: HTMLElement) {
    const messages = document.createElement("div");
    messages.addClass("agenter-messages");
    root.appendChild(messages);
    this.messagesEl = messages;
  }

  private buildInput(root: HTMLElement) {
    const inputWrap = document.createElement("div");
    inputWrap.addClass("agenter-input-wrap");

    // A single rounded composer: context chip on top, the text area in the
    // middle, and the model selector + action buttons on the bottom row.
    const composer = document.createElement("div");
    composer.addClass("agenter-composer");

    // --- Top row: context / scope chip. ---
    const contextRow = document.createElement("div");
    contextRow.addClass("agenter-composer-context");
    const contextBtn = document.createElement("button");
    contextBtn.addClass("agenter-context-chip");
    contextBtn.setAttribute("type", "button");
    safeIcon(contextBtn, this.scopeIcon(this.scope));
    const contextText = document.createElement("span");
    contextText.textContent = this.contextLabel();
    contextBtn.appendChild(contextText);
    contextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openContextMenu(contextBtn, contextText);
    });
    contextRow.appendChild(contextBtn);
    composer.appendChild(contextRow);

    // --- Middle: the text area. ---
    const input = document.createElement("textarea");
    input.addClass("agenter-input");
    input.placeholder = "Ask anything, type / for custom prompts";
    input.rows = 1;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send();
      } else if (e.key === "/" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.openActionMenu(input);
      }
    });
    input.addEventListener("input", () => {
      this.autoGrow();
      if (this.inputEl.value.trim() === "/") this.openActionMenu(input);
    });
    this.inputEl = input;
    composer.appendChild(input);

    // --- Bottom row: model selector (left) + actions & send (right). ---
    const footer = document.createElement("div");
    footer.addClass("agenter-composer-footer");

    const footerLeft = document.createElement("div");
    footerLeft.addClass("agenter-composer-left");

    const providerBtn = document.createElement("button");
    providerBtn.addClass("agenter-provider-btn");
    providerBtn.setAttribute("type", "button");
    this.providerBtn = providerBtn;
    providerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openProviderMenu(providerBtn);
    });
    footerLeft.appendChild(providerBtn);

    const modelBtn = mkIconBtn("settings", "Model settings", (e) => {
      e?.stopPropagation();
      this.openModelMenu(modelBtn);
    });
    modelBtn.addClass("agenter-model-settings-btn");
    footerLeft.appendChild(modelBtn);
    footer.appendChild(footerLeft);

    const footerRight = document.createElement("div");
    footerRight.addClass("agenter-composer-right");

    const slashBtn = mkIconBtn("sparkles", "AI actions", (e) => {
      e?.stopPropagation();
      this.openActionMenu(slashBtn);
    });
    slashBtn.addClass("agenter-inline-btn");
    footerRight.appendChild(slashBtn);

    const pasteBtn = mkIconBtn("image", "Insert selected text from current note", () => {
      const sel = this.getEditorSelection();
      if (sel) {
        this.inputEl.value = this.inputEl.value
          ? `${this.inputEl.value}\n\n${sel}`
          : sel;
        this.autoGrow();
        this.inputEl.focus();
      } else {
        new Notice("No text selected in the active note.");
      }
    });
    pasteBtn.addClass("agenter-inline-btn");
    footerRight.appendChild(pasteBtn);

    const sendBtn = document.createElement("button");
    sendBtn.addClass("agenter-send");
    safeIcon(sendBtn, "arrow-up");
    sendBtn.setAttribute("aria-label", "Send");
    sendBtn.title = "Send";
    sendBtn.addEventListener("click", () => this.send());
    this.sendBtn = sendBtn;
    footerRight.appendChild(sendBtn);

    footer.appendChild(footerRight);
    composer.appendChild(footer);

    inputWrap.appendChild(composer);
    root.appendChild(inputWrap);
    this.refreshProviderLabel();
  }

  private openActionMenu(anchor: HTMLElement) {
    const menu = new Menu();
    const prompts = this.plugin.settings.customPrompts ?? {};
    const addPrompt = (label: string, prompt: string) => {
      menu.addItem((item) =>
        item.setTitle(label).onClick(() => {
          this.insertPrompt(prompt);
          this.inputEl.focus();
        })
      );
    };
    const builtInLabels: Record<string, string> = {
      summarize: "Summarize selection",
      rewrite: "Rewrite selection",
      extract: "Extract tasks",
    };
    const promptEntries = Object.entries(prompts);
    // Show every prompt saved by the Prompt Builder. Built-ins retain their
    // familiar labels; custom entries use their user-defined names.
    for (const [key, template] of promptEntries) {
      const label = builtInLabels[key] ?? key.replace(/[-_]/g, " ");
      addPrompt(label, String(template));
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("Open settings").onClick(() => {
        (this.plugin as any).app.setting.open();
        (this.plugin as any).app.setting.openTabById("agenter");
      })
    );
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }

  private openContextMenu(anchor: HTMLElement, labelEl: HTMLElement) {
    const menu = new Menu();
    (["note", "folder", "vault", "none"] as const).forEach((scope) => {
      menu.addItem((item) =>
        item
          .setTitle(`${scope === "note" ? this.currentNoteLabel() : scope}`)
          .setChecked(scope === this.scope)
          .onClick(() => {
            this.scope = scope;
            labelEl.textContent = this.contextLabel();
            const icon = anchor.querySelector("svg")?.parentElement ?? anchor;
            safeIcon(icon as HTMLElement, this.scopeIcon(scope));
          })
      );
    });
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }

  private openModelMenu(anchor: HTMLElement) {
    document.querySelector(".agenter-model-popover")?.remove();
    const pop = document.createElement("div");
    pop.addClass("agenter-model-popover");

    const provider = getActiveProvider(this.plugin.settings);
    const header = document.createElement("div");
    header.addClass("agenter-model-popover-head");
    const title = document.createElement("strong");
    title.textContent = provider ? provider.name : "Model settings";
    const model = document.createElement("span");
    model.textContent = provider?.model ?? "No model selected";
    header.append(title, model);
    pop.appendChild(header);

    const addNumericControl = (
      labelText: string,
      min: number,
      max: number,
      step: number,
      value: number,
      onValue: (value: number) => void
    ) => {
      const row = document.createElement("div");
      row.addClass("agenter-model-control");
      const label = document.createElement("label");
      label.textContent = labelText;
      const number = document.createElement("input");
      number.type = "number";
      number.min = String(min);
      number.max = String(max);
      number.step = String(step);
      number.value = String(value);
      number.setAttribute("aria-label", labelText);
      const range = document.createElement("input");
      range.type = "range";
      range.min = String(min);
      range.max = String(max);
      range.step = String(step);
      range.value = String(value);
      range.setAttribute("aria-label", `${labelText} slider`);

      const apply = (raw: string, commit = false) => {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) return;
        const next = Math.max(min, Math.min(max, parsed));
        range.value = String(next);
        if (commit) number.value = String(next);
        onValue(next);
        if (commit) void this.plugin.saveSettings();
      };
      range.addEventListener("input", () => {
        number.value = range.value;
        apply(range.value);
      });
      range.addEventListener("change", () => apply(range.value, true));
      number.addEventListener("input", () => apply(number.value));
      number.addEventListener("change", () => apply(number.value, true));
      number.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { apply(number.value, true); number.blur(); }
      });

      const top = document.createElement("div");
      top.addClass("agenter-model-control-top");
      top.append(label, number);
      row.append(top, range);
      pop.appendChild(row);
    };

    addNumericControl("Temperature", 0, 2, 0.1, this.plugin.settings.temperature, (v) => {
      this.plugin.settings.temperature = Number(v.toFixed(1));
    });
    addNumericControl("Max tokens", 256, 128000, 256, this.plugin.settings.maxTokens, (v) => {
      this.plugin.settings.maxTokens = Math.round(v);
    });

    const full = document.createElement("button");
    full.addClass("agenter-model-full-settings");
    full.textContent = "Open full model settings";
    full.addEventListener("click", () => {
      pop.remove();
      (this.plugin as any).app.setting.open();
      (this.plugin as any).app.setting.openTabById("agenter");
    });
    pop.appendChild(full);
    document.body.appendChild(pop);

    const rect = anchor.getBoundingClientRect();
    const width = 320;
    const left = Math.max(10, Math.min(rect.left, window.innerWidth - width - 10));
    pop.style.left = `${left}px`;
    const estimatedHeight = 250;
    const below = rect.bottom + 7;
    pop.style.top = `${below + estimatedHeight > window.innerHeight ? Math.max(10, rect.top - estimatedHeight - 7) : below}px`;

    const close = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        pop.remove();
        document.removeEventListener("mousedown", close, true);
      }
    };
    window.setTimeout(() => document.addEventListener("mousedown", close, true), 0);
  }

  private contextLabel(): string {
    if (this.scope === "note") return this.currentNoteLabel();
    if (this.scope === "folder") {
      const folder = this.app.workspace.getActiveFile()?.parent?.path || "folder";
      return folder === "/" ? "folder" : folder;
    }
    return this.scope;
  }

  private currentNoteLabel(): string {
    const file = this.app.workspace.getActiveFile();
    return file?.basename || file?.name || "current note";
  }

  private scopeIcon(scope: Scope): string {
    if (scope === "folder") return "folder";
    if (scope === "vault") return "database";
    if (scope === "none") return "x";
    return "file-text";
  }

  private insertPrompt(text: string) {
    const prefix = this.inputEl.value.trim();
    this.inputEl.value = prefix && prefix !== "/" ? `${prefix}\n${text}` : text;
    this.autoGrow();
    this.inputEl.focus();
    const end = this.inputEl.value.length;
    this.inputEl.setSelectionRange(end, end);
  }

  public insertPromptFromOutside(text: string) {
    this.insertPrompt(text);
  }

  public submitPromptFromOutside(text: string) {
    this.insertPrompt(text);
    void this.send();
  }

  /** Reload the active session into this panel (used when a contextual chat
   *  hands its conversation back to the main panel). */
  public reloadActiveSession() {
    this.loadActiveSession();
    this.renderSessionList();
  }

  public moveNear(x: number, y: number) {
    if (this.mode !== "floating") return;
    const width = this.rootEl.offsetWidth || this.plugin.settings.panelWidth || 420;
    const height = this.rootEl.offsetHeight || this.plugin.settings.panelHeight || 600;
    this.pos.x = Math.max(10, Math.min(x + 12, window.innerWidth - width - 10));
    this.pos.y = Math.max(10, Math.min(y + 12, window.innerHeight - height - 10));
    this.rootEl.style.left = `${this.pos.x}px`;
    this.rootEl.style.top = `${this.pos.y}px`;
    this.inputEl.focus();
  }

  private autoGrow() {
    const el = this.inputEl;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }

  // ----------------------------------------------------- provider menu
  private refreshProviderLabel() {
    const p = getActiveProvider(this.plugin.settings);
    this.providerBtn.setText(p ? `${p.name}` : "no provider");
  }

  private openProviderMenu(anchor: HTMLElement) {
    const menu = new Menu();
    this.plugin.settings.providers.forEach((p) => {
      menu.addItem((item) =>
        item
          .setTitle(`${p.name} — ${p.model}`)
          .setChecked(p.id === this.plugin.settings.activeProviderId)
          .onClick(async () => {
            this.plugin.settings.activeProviderId = p.id;
            await this.plugin.saveSettings();
            this.refreshProviderLabel();
            this.appendSystem(`Switched to **${p.name} / ${p.model}**`);
          })
      );
      menu.addItem((item) =>
        item.setTitle(`  ↳ Fetch & pick model for ${p.name}`).onClick(async () => {
          const res = await probeModels(p);
          if (!res.ok) {
            new Notice(`❌ ${p.name}: ${res.error ?? "failed"}`);
            return;
          }
          if (!res.models.length) {
            new Notice(`✅ ${p.name}: connected (no model list)`);
            return;
          }
          const mMenu = new Menu();
          res.models.forEach((m) => {
            mMenu.addItem((mi) =>
              mi
                .setTitle(m)
                .setChecked(m === p.model)
                .onClick(async () => {
                  p.model = m;
                  if (this.plugin.settings.activeProviderId === p.id) {
                    this.refreshProviderLabel();
                    this.appendSystem(`Model set to **${m}**`);
                  }
                  await this.plugin.saveSettings();
                })
            );
          });
          mMenu.showAtPosition({
            x: anchor.getBoundingClientRect().left,
            y: anchor.getBoundingClientRect().bottom + 4,
          });
        })
      );
    });
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("Open settings…").onClick(() => {
        (this.plugin as any).app.setting.open();
        (this.plugin as any).app.setting.openTabById("agenter");
      })
    );
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }

  // --------------------------------------------------------- history I/O
  private loadActiveSession() {
    const session = this.currentSession();
    this.messages = [];
    this.messagesEl.empty();
    if (!session.messages.length) {
      this.addWelcome();
      return;
    }
    for (const m of session.messages) {
      if (m.role === "tool") {
        this.appendToolLine(m.toolName ?? "tool", m.content);
      } else if (m.role === "system") {
        this.appendSystem(m.content);
      } else {
        this.appendMessage(m.role as "user" | "assistant", m.content);
        this.messages.push({ role: m.role as any, content: m.content });
      }
    }
    this.scrollToBottom();
  }

  private async persist() {
    const session = this.currentSession();
    const stored: StoredMessage[] = [];
    this.messagesEl.querySelectorAll(".agenter-msg, .agenter-tool-line").forEach((el) => {
      const e = el as HTMLElement;
      if (e.classList.contains("agenter-tool-line")) {
        stored.push({
          role: "tool",
          content: e.dataset.raw ?? "",
          toolName: e.dataset.toolName,
        });
      } else if (e.classList.contains("agenter-msg-user")) {
        stored.push({ role: "user", content: e.dataset.raw ?? "" });
      } else if (e.classList.contains("agenter-msg-assistant")) {
        stored.push({ role: "assistant", content: e.dataset.raw ?? "" });
      } else if (e.classList.contains("agenter-msg-system")) {
        stored.push({ role: "system", content: e.dataset.raw ?? "" });
      }
    });
    session.messages = stored.slice(-200);
    session.updatedAt = Date.now();
    if (session.title === "New chat") session.title = deriveTitle(session.messages);
    await this.plugin.saveSettings();
    this.renderSessionList();
  }

  // ------------------------------------------------------------ messages
  private addWelcome() {
    const provider = getActiveProvider(this.plugin.settings);
    const name = provider ? `${provider.name} / ${provider.model}` : "no provider configured";
    this.appendMessage(
      "assistant",
      `Hi! I'm **Agenter**, connected to **${name}**.\n\n` +
        `I can read, write, edit, and summarize your notes, search the web, and look at images inside your notes. ` +
        `When I want to change a note I'll show you an action card to approve first.\n\n` +
        `Pick a context scope above, then ask me anything.`
    );
  }

  /** Render a user/assistant message bubble with markdown. */
  private appendMessage(role: "user" | "assistant", text: string): HTMLElement {
    const el = document.createElement("div");
    el.addClass("agenter-msg", `agenter-msg-${role}`);
    el.dataset.raw = text;

    const avatar = document.createElement("div");
    avatar.addClass("agenter-avatar");
    safeIcon(avatar, role === "user" ? "user" : "bot");
    el.appendChild(avatar);

    const bubble = document.createElement("div");
    bubble.addClass("agenter-bubble");
    el.appendChild(bubble);

    this.renderMarkdown(text, bubble);

    this.messagesEl.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  private appendSystem(text: string): HTMLElement {
    const el = document.createElement("div");
    el.addClass("agenter-msg-system");
    el.dataset.raw = text;
    this.renderMarkdown(text, el);
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  /** A compact one-line indicator that a (non-mutating) tool ran. */
  private appendToolLine(name: string, result: string, args: any = {}): HTMLElement {
    const el = document.createElement("div");
    el.addClass("agenter-tool-line");
    el.dataset.toolName = name;
    el.dataset.raw = result;
    const documentTools = new Set(["read_note", "read_note_section", "summarize_note", "current_note"]);
    if (documentTools.has(name)) el.addClass("is-document", "is-open");

    const head = document.createElement("div");
    head.addClass("agenter-tool-line-head");
    const ico = document.createElement("span");
    safeIcon(ico, TOOL_LABELS[name]?.icon ?? "wrench");
    head.appendChild(ico);
    const labelWrap = document.createElement("span");
    labelWrap.addClass("agenter-tool-label");
    const label = document.createElement("strong");
    label.textContent = TOOL_LABELS[name]?.verb ?? name;
    labelWrap.appendChild(label);
    if (args?.path) {
      const path = document.createElement("small");
      path.textContent = String(args.path);
      labelWrap.appendChild(path);
    }
    head.appendChild(labelWrap);
    const chevron = document.createElement("span");
    chevron.addClass("agenter-tool-chevron");
    safeIcon(chevron, "chevron-down");
    head.appendChild(chevron);
    el.appendChild(head);

    const body = document.createElement("div");
    body.addClass("agenter-tool-line-body", "markdown-rendered");
    const sourcePath = typeof args?.path === "string" ? args.path : "";
    this.renderMarkdown(result, body, sourcePath);
    el.appendChild(body);

    head.addEventListener("click", () => el.toggleClass("is-open", !el.hasClass("is-open")));
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  private renderMarkdown(text: string, target: HTMLElement, sourcePath = "") {
    target.empty();
    target.addClass("markdown-rendered");
    target.setAttribute("dir", detectTextDirection(text));
    MarkdownRenderer.render(this.app, text, target, sourcePath, this.component).catch(() => {
      target.setText(text);
    });
  }

  private showTyping(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.addClass("agenter-msg", "agenter-msg-assistant", "is-typing");
    const avatar = document.createElement("div");
    avatar.addClass("agenter-avatar");
    safeIcon(avatar, "bot");
    wrap.appendChild(avatar);
    const bubble = document.createElement("div");
    bubble.addClass("agenter-bubble");
    const label = document.createElement("span");
    label.addClass("agenter-typing-label");
    label.textContent = "Thinking";
    bubble.appendChild(label);
    const typing = document.createElement("div");
    typing.addClass("agenter-typing");
    typing.innerHTML = "<span></span><span></span><span></span>";
    bubble.appendChild(typing);
    wrap.appendChild(bubble);
    this.messagesEl.appendChild(wrap);
    this.scrollToBottom();
    return wrap;
  }

  private beginActivity() {
    this.startedAt = Date.now();
    this.hadError = false;
    this.rootEl.addClass("is-busy");
    this.setStatus("thinking", "Thinking");
    this.clearStatusTimers();
    this.statusTimer = window.setInterval(() => {
      if (!this.busy) return;
      this.statusMetaEl.textContent = this.formatElapsed(Date.now() - this.startedAt);
    }, 250);
  }

  private setStatus(
    state: "idle" | "thinking" | "responding" | "tool" | "approval" | "done" | "error",
    text: string,
    meta = ""
  ) {
    this.statusEl.className = `agenter-status is-${state}`;
    this.statusTextEl.textContent = text;
    this.statusMetaEl.textContent = meta;

    const icon =
      state === "error"
        ? "circle-alert"
        : state === "done"
          ? "circle-check"
          : state === "approval"
            ? "shield-question"
            : state === "tool"
              ? "wrench"
              : state === "idle"
                ? "circle"
                : "loader-circle";
    safeIcon(this.statusIconEl, icon, state === "error" ? "!" : "•");
  }

  private finishActivity(label = "Completed") {
    const elapsed = this.startedAt ? this.formatElapsed(Date.now() - this.startedAt) : "";
    this.busy = false;
    this.rootEl.removeClass("is-busy");
    if (this.statusTimer !== null) {
      window.clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (!this.hadError) this.setStatus("done", label, elapsed);
    this.statusResetTimer = window.setTimeout(() => {
      if (!this.busy && !this.destroyed) this.setStatus("idle", "Ready");
    }, 2800);
  }

  private clearStatusTimers() {
    if (this.statusTimer !== null) {
      window.clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.statusResetTimer !== null) {
      window.clearTimeout(this.statusResetTimer);
      this.statusResetTimer = null;
    }
  }

  private formatElapsed(ms: number): string {
    if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
    return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
  }

  private scheduleStreamRender() {
    if (this.streamRenderTimer !== null) return;
    this.streamRenderTimer = window.setTimeout(() => {
      this.streamRenderTimer = null;
      this.flushStreamRender();
    }, 40);
  }

  private flushStreamRender() {
    if (!this.streamEl) return;
    const bubble = this.streamEl.querySelector(".agenter-bubble") as HTMLElement;
    if (!bubble) return;
    this.streamEl.dataset.raw = this.streamBuf;
    this.renderMarkdown(this.streamBuf, bubble);
    this.scrollToBottom();
  }

  // ----------------------------------------------------- action cards
  /**
   * Render an inline approval card for a mutating tool call and return a
   * promise that resolves true (approve) / false (reject) once the user
   * clicks. Used by the orchestrator's onApprovalRequest hook.
   */
  private requestApproval(call: ToolCall): Promise<boolean> {
    return new Promise((resolve) => {
      this.setStatus("approval", "Waiting for approval", TOOL_LABELS[call.name]?.verb ?? call.name);
      let args: any = {};
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {
        /* ignore */
      }
      const meta = TOOL_LABELS[call.name] ?? { icon: "wrench", verb: call.name };

      const card = document.createElement("div");
      card.addClass("agenter-action-card");
      const destructive = call.name === "trash_note";
      if (destructive) card.addClass("is-destructive");

      const head = document.createElement("div");
      head.addClass("agenter-action-head");
      const ico = document.createElement("span");
      ico.addClass("agenter-action-icon");
      safeIcon(ico, meta.icon);
      head.appendChild(ico);
      const title = document.createElement("div");
      title.addClass("agenter-action-title");
      title.innerHTML = `<strong>${meta.verb}</strong>`;
      if (args.path) {
        const path = document.createElement("div");
        path.addClass("agenter-action-path");
        path.textContent = args.path;
        title.appendChild(path);
      }
      head.appendChild(title);
      card.appendChild(head);

      // Preview of what will change.
      const previewText = this.approvalPreview(call.name, args);
      if (previewText) {
        const pre = document.createElement("pre");
        pre.addClass("agenter-action-preview");
        pre.textContent = previewText;
        card.appendChild(pre);
      }

      const actions = document.createElement("div");
      actions.addClass("agenter-action-buttons");
      const approve = document.createElement("button");
      approve.addClass("agenter-action-approve");
      approve.textContent = destructive ? "Review deletion" : "Approve";
      const reject = document.createElement("button");
      reject.addClass("agenter-action-reject");
      reject.textContent = "Reject";
      actions.appendChild(reject);
      actions.appendChild(approve);
      card.appendChild(actions);

      const settle = (ok: boolean) => {
        actions.remove();
        const status = document.createElement("div");
        status.addClass("agenter-action-status", ok ? "is-approved" : "is-rejected");
        status.textContent = ok ? "✓ Approved" : "✕ Rejected";
        card.appendChild(status);
        card.addClass(ok ? "is-approved" : "is-rejected");
        this.setStatus("thinking", ok ? "Continuing" : "Handling rejection");
        resolve(ok);
      };
      let armed = false;
      let armTimer: number | null = null;
      approve.addEventListener("click", () => {
        if (!destructive) { settle(true); return; }
        if (!armed) {
          armed = true;
          card.addClass("is-armed");
          approve.textContent = "Click again: Move to Trash";
          armTimer = window.setTimeout(() => {
            armed = false;
            card.removeClass("is-armed");
            approve.textContent = "Review deletion";
          }, 6000);
          return;
        }
        if (armTimer !== null) window.clearTimeout(armTimer);
        settle(true);
      });
      reject.addEventListener("click", () => settle(false));

      this.messagesEl.appendChild(card);
      this.scrollToBottom();
    });
  }

  private approvalPreview(name: string, args: any): string {
    if (name === "append_note") return truncate(args.content ?? "", 600);
    if (name === "write_note") return truncate(args.content ?? "", 600);
    if (name === "edit_note") {
      return `- ${truncate(args.old_string ?? "", 260)}\n+ ${truncate(args.new_string ?? "", 260)}`;
    }
    if (name === "create_folder") return `Create folder inside vault:\n${args.path ?? ""}`;
    if (name === "move_note") return `From: ${args.path ?? ""}\nTo: ${args.destination ?? ""}\n\nA safety backup will be created first.`;
    if (name === "trash_note") return `Move this note to recoverable Obsidian Trash:\n${args.path ?? ""}\n\nA safety backup will be created inside .agenter-backups first. Permanent deletion is not used.`;
    return "";
  }

  // --------------------------------------------------------------- send
  private async send() {
    if (this.busy) return;
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    this.autoGrow();

    // Drop the welcome message on first real turn.
    const welcome = this.messagesEl.querySelector(".agenter-msg-assistant");
    if (!this.messages.length && welcome) this.messagesEl.empty();

    this.appendMessage("user", text);
    this.messages.push({ role: "user", content: text });

    this.busy = true;
    this.aborted = false;
    this.sendBtn.disabled = true;
    this.toggleStop(true);
    this.beginActivity();
    const typing = this.showTyping();

    const contextNote = this.buildContextNote();
    const prompt = contextNote ? `${contextNote}\n\n${text}` : text;

    this.orchestrator.setMessages(this.messages.slice(0, -1));
    this.orchestrator.shouldAbort = () => this.aborted;
    this.streamBuf = "";
    this.streamEl = null;

    // Tracks the name of the tool currently running, so its result line
    // can be labelled correctly when onToolResult fires.
    let pendingTool: string | null = null;
    let pendingToolArgs: any = {};

    const cb: ChatCallbacks = {
      onAssistantToken: (t) => {
        if (this.aborted) return;
        if (typing.parentNode) typing.remove();
        if (!this.streamEl) {
          this.streamEl = this.appendMessage("assistant", "");
          this.streamBuf = "";
        }
        this.streamBuf += t;
        this.streamEl.dataset.raw = this.streamBuf;
        this.setStatus("responding", "Writing response");
        this.scheduleStreamRender();
      },
      onToolUse: (name, args) => {
        if (this.aborted) return;
        this.flushStreamRender();
        // Reset the streaming target so text after a tool starts a fresh bubble.
        this.streamEl = null;
        this.streamBuf = "";
        pendingTool = name;
        try { pendingToolArgs = JSON.parse(args || "{}"); } catch { pendingToolArgs = {}; }
        this.setStatus("tool", TOOL_LABELS[name]?.verb ?? `Running ${name}`);
      },
      onToolResult: (result) => {
        if (this.aborted) return;
        this.appendToolLine(pendingTool ?? "tool", result, pendingToolArgs);
        pendingTool = null;
        pendingToolArgs = {};
        this.setStatus("thinking", "Reviewing tool result");
      },
      onApprovalRequest: (call) => this.requestApproval(call),
      onError: (err) => {
        if (typing.parentNode) typing.remove();
        this.hadError = true;
        this.setStatus("error", "Request failed");
        this.appendSystem(`**Error:** ${err}`);
      },
      onDone: () => {
        this.flushStreamRender();
        this.sendBtn.disabled = false;
        this.toggleStop(false);
        if (typing.parentNode) typing.remove();
        this.syncMessages();
        this.finishActivity();
        void this.persist();
      },
    };

    await this.orchestrator.run(prompt, cb);
    if (!this.aborted && this.orchestrator.messages.length) {
      this.messages = this.orchestrator.messages;
    }
  }

  private syncMessages() {
    const msgs: ChatMessage[] = [];
    this.messagesEl.querySelectorAll(".agenter-msg").forEach((el) => {
      const e = el as HTMLElement;
      if (e.classList.contains("is-typing")) return;
      if (e.classList.contains("agenter-msg-user"))
        msgs.push({ role: "user", content: e.dataset.raw ?? "" });
      else if (e.classList.contains("agenter-msg-assistant"))
        msgs.push({ role: "assistant", content: e.dataset.raw ?? "" });
    });
    this.messages = msgs;
  }

  private abort() {
    this.aborted = true;
    this.sendBtn.disabled = false;
    this.toggleStop(false);
    this.finishActivity("Stopped");
  }

  private toggleStop(show: boolean) {
    const header = this.rootEl.querySelector(".agenter-header") as any;
    const stop = header?._stopBtn as HTMLElement | undefined;
    if (stop) stop.style.display = show ? "flex" : "none";
  }

  // ------------------------------------------------------------ context
  private buildContextNote(): string {
    if (this.scope === "none") return "";
    if (this.scope === "note") {
      const file = this.app.workspace.getActiveFile();
      if (!file) return "";
      return `[Context: current note is "${file.path}". Use the current_note tool to read it.]`;
    }
    if (this.scope === "folder") {
      const file = this.app.workspace.getActiveFile();
      const folder = file?.parent?.path ?? "";
      return `[Context scope: folder "${folder}". Use list_notes / read_note / search_notes tools.]`;
    }
    if (this.scope === "vault") {
      return `[Context scope: whole vault. Use list_notes / search_notes / read_note tools.]`;
    }
    return "";
  }

  // ------------------------------------------------------------ controls
  private toggleMode() {
    void this.persist();
    if (this.mode === "docked") this.options.onRequestFloat?.();
    else this.options.onRequestDock?.();
  }

  private toggleMinimize() {
    this.minimized = !this.minimized;
    this.rootEl.toggleClass("is-minimized", this.minimized);
    if (this.minimized) {
      this.rootEl.style.height = "auto";
    } else {
      this.rootEl.style.height =
        this.mode === "floating" ? `${this.plugin.settings.panelHeight}px` : "100vh";
    }
  }

  private makeDraggable(handle: HTMLElement) {
    let dragging = false;
    let offX = 0;
    let offY = 0;
    handle.addEventListener("mousedown", (e) => {
      if (this.mode !== "floating" || this.minimized) return;
      if ((e.target as HTMLElement).closest("button")) return;
      dragging = true;
      offX = e.clientX - this.pos.x;
      offY = e.clientY - this.pos.y;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      this.pos.x = e.clientX - offX;
      this.pos.y = e.clientY - offY;
      this.rootEl.style.left = `${this.pos.x}px`;
      this.rootEl.style.top = `${this.pos.y}px`;
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  private scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private getEditorSelection(): string | null {
    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView) as any;
      if (view && view.editor) {
        const sel = view.editor.getSelection();
        return sel && sel.trim() ? sel.trim() : null;
      }
    } catch {
      /* ignore */
    }
    const s = window.getSelection();
    const txt = s ? s.toString().trim() : "";
    return txt || null;
  }

  private close() {
    void this.persist();
    if (this.options.onRequestClose) this.options.onRequestClose();
    else this.destroy();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    void this.persist();
    this.clearStatusTimers();
    if (this.streamRenderTimer !== null) {
      window.clearTimeout(this.streamRenderTimer);
      this.streamRenderTimer = null;
    }
    this.component.unload();
    this.rootEl?.remove();
  }
}

/**
 * Render a compact, stroke-only SVG without relying on Obsidian's icon
 * registry. This keeps controls visible across Obsidian versions/themes.
 */
function safeIcon(el: HTMLElement, icon: string, fallback = "•") {
  const paths: Record<string, string> = {
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    square: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    copy: '<rect x="9" y="9" width="10" height="10" rx="1"/><path d="M15 9V6a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3"/>',
    check: '<path d="M5 12l4 4L19 6"/>',
    "arrow-up": '<path d="M12 19V5M6 11l6-6 6 6"/>',
    "chevron-down": '<path d="M6 9l6 6 6-6"/>',
    "chevron-up": '<path d="M6 15l6-6 6 6"/>',
    pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>',
    "file-plus": '<path d="M5 3h9l5 5v13H5zM14 3v6h6M12 12v6M9 15h6"/>',
    "file-text": '<path d="M5 3h9l5 5v13H5zM14 3v6h6M8 13h8M8 17h8"/>',
    file: '<path d="M5 3h9l5 5v13H5zM14 3v6h6"/>',
    folder: '<path d="M3 6h7l2 2h9v11H3z"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/>',
    image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M4 17l5-5 3 3 2-2 6 6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
    "align-left": '<path d="M4 6h16M4 10h11M4 14h16M4 18h11"/>',
    wrench: '<path d="M14 6a4 4 0 0 0-5 5L4 16l4 4 5-5a4 4 0 0 0 5-5l-3 3-3-3 2-4z"/>',
    bot: '<rect x="5" y="7" width="14" height="12" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6"/>',
    user: '<circle cx="12" cy="8" r="3"/><path d="M5 21c.7-4 3-6 7-6s6.3 2 7 6"/>',
    pin: '<path d="M9 4l6 6M7 10l7 7M5 19l6-6M14 4l6 6-4 1-5 5-1 4-4-4 4-1 5-5z"/>',
    sparkles: '<path d="M12 3l1.7 5.2L19 10l-5.3 1.8L12 17l-1.7-5.2L5 10l5.3-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8zM5 3l.8 2.2L8 6l-2.2.8L5 9l-.8-2.2L2 6l2.2-.8z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    "external-link": '<path d="M14 4h6v6M10 14L20 4"/><path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    database: '<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
    "maximize-2": '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5"/>',
    "panel-right": '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    "circle-check": '<circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9"/>',
    "circle-alert": '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/>',
    "shield-question": '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6zM10 10a2 2 0 1 1 3.7 1l-1.2 1.1V14M12 17h.01"/>',
    "loader-circle": '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
    circle: '<circle cx="12" cy="12" r="6"/>',
  };
  const path = paths[icon];
  el.empty();
  if (!path) {
    el.textContent = fallback;
    el.style.fontSize = "16px";
    el.style.lineHeight = "1";
    return;
  }
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

function mkIconBtn(
  icon: string,
  title: string,
  onClick: (e?: MouseEvent) => void
): HTMLButtonElement {
  const b = document.createElement("button");
  b.addClass("agenter-icon-btn");
  safeIcon(b, icon);
  b.setAttribute("aria-label", title);
  b.title = title;
  b.addEventListener("click", (e) => {
    e.preventDefault();
    onClick(e);
  });
  return b;
}

function detectTextDirection(text: string): "rtl" | "ltr" {
  const plain = String(text ?? "").replace(/^[#>*_`~\-+\d.\s]+/, "");
  const rtl = plain.search(/[\u0590-\u08FF]/);
  const ltr = plain.search(/[A-Za-z]/);
  return rtl >= 0 && (ltr < 0 || rtl < ltr) ? "rtl" : "ltr";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
