import { Editor, ItemView, MarkdownView, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import {
  AgentSettings,
  DEFAULT_SETTINGS,
  AgentSettingTab,
  deriveTitle,
  getActiveSession,
} from "./src/settings";
import { FloatingChatPanel } from "./src/ui";
import { SelectionPopover, openSelectionPopover } from "./src/selection-popover";
import { fetchCloudflareModels, cacheExpiry } from "./src/cloudflare";
import { connectCloudflareOAuth, listCloudflareAccounts, refreshCloudflareOAuth, revokeCloudflareOAuth } from "./src/cloudflare-oauth";

export const AGENTER_VIEW_TYPE = "agenter-chat-view";

/**
 * `cursorCoords` is part of Obsidian's CodeMirror-backed editor but is not in
 * the public typings, so it is declared here instead of casting to `any`.
 */
interface EditorWithCoords extends Editor {
  cursorCoords?: (
    start: boolean,
    mode?: "window" | "page" | "local"
  ) => { left: number; top: number; bottom: number } | undefined;
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
  settings!: AgentSettings;
  activeChatPanel: FloatingChatPanel | null = null;
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
      id: "open-chat",
      name: "Open chat in right sidebar",
      callback: () => void this.openDockedChat(),
    });

    this.addCommand({
      id: "open-floating-chat",
      name: "Open floating chat",
      callback: () => void this.openFloatingChat(),
    });

    this.addCommand({
      id: "close-chat",
      name: "Close chat",
      callback: () => this.closeAllPanels(),
    });

    this.addCommand({
      id: "ai-action-on-selection",
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

    if (this.settings.cloudflareAutoSync) void this.syncCloudflareCatalogs(false);
  }

  onunload() {
    if (this.selectionTimer !== null) window.clearTimeout(this.selectionTimer);
    SelectionPopover.closeCurrent();
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

  async ensureCloudflareAccessToken(providerId?: string) {
    const provider = providerId
      ? this.settings.providers.find((p) => p.id === providerId)
      : this.settings.providers.find((p) => p.id === this.settings.activeProviderId);
    if (!provider || provider.type !== "cloudflare" || provider.cloudflareAuthMode !== "oauth") return;
    const expiresAt = provider.cloudflareOAuthExpiresAt ?? 0;
    if (expiresAt > Date.now() + 60_000) return;
    if (!provider.cloudflareOAuthRefreshToken) throw new Error("Cloudflare authorization expired. Connect Cloudflare again.");
    const tokens = await refreshCloudflareOAuth(this.settings.cloudflareOAuthClientId, provider.cloudflareOAuthRefreshToken);
    provider.apiKey = tokens.accessToken;
    provider.cloudflareOAuthRefreshToken = tokens.refreshToken ?? provider.cloudflareOAuthRefreshToken;
    provider.cloudflareOAuthExpiresAt = tokens.expiresAt;
    provider.cloudflareOAuthScope = tokens.scope;
    await this.saveSettings();
  }

  async connectCloudflareToken(providerId: string, accountId: string, token: string): Promise<number> {
    const provider = this.settings.providers.find((p) => p.id === providerId);
    if (!provider || provider.type !== "cloudflare") throw new Error("Cloudflare provider was not found.");
    const candidate = { ...provider, cloudflareAccountId: accountId.trim(), apiKey: token.trim(), cloudflareAuthMode: "token" as const };
    const models = await fetchCloudflareModels(candidate);
    if (!models.length) throw new Error("Cloudflare connected but returned no Workers AI models.");
    provider.cloudflareAccountId = accountId.trim();
    provider.apiKey = token.trim();
    provider.cloudflareAuthMode = "token";
    provider.cloudflareOAuthRefreshToken = "";
    provider.cloudflareOAuthExpiresAt = undefined;
    provider.cloudflareOAuthScope = "";
    provider.connectionStatus = "connected";
    provider.lastConnectionTestAt = Date.now();
    provider.lastConnectionError = "";
    this.settings.modelCatalogs[provider.id] = {
      providerId: provider.id,
      providerType: provider.type,
      syncedAt: Date.now(),
      expiresAt: cacheExpiry(),
      models,
    };
    if (!models.some((model) => model.id === provider.model)) provider.model = models[0].id;
    const selectedModel = models.find((model) => model.id === provider.model);
    provider.cloudflareModelTask = selectedModel?.task ?? String((selectedModel?.raw as any)?.task?.name ?? (selectedModel?.raw as any)?.task ?? "");
    await this.saveSettings();
    this.activeChatPanel?.refreshProviderLabel();
    return models.length;
  }

  async connectCloudflare(providerId: string) {
    const provider = this.settings.providers.find((p) => p.id === providerId);
    if (!provider || provider.type !== "cloudflare") throw new Error("Cloudflare provider was not found.");
    const tokens = await connectCloudflareOAuth(this.settings.cloudflareOAuthClientId);
    if (tokens.scope !== undefined && !tokens.scope.trim()) {
      try { await revokeCloudflareOAuth(this.settings.cloudflareOAuthClientId, tokens.accessToken); } catch { /* best effort */ }
      throw new Error("Cloudflare returned a token with zero permissions. Add Account Settings Read, Workers AI Read, and Workers AI Edit to the OAuth client, then reconnect.");
    }
    const accounts = await listCloudflareAccounts(tokens.accessToken);
    if (!accounts.length) throw new Error("Cloudflare returned no accessible account. Add Account Settings Read to the OAuth client and reconnect.");
    provider.apiKey = tokens.accessToken;
    provider.cloudflareOAuthRefreshToken = tokens.refreshToken;
    provider.cloudflareOAuthExpiresAt = tokens.expiresAt;
    provider.cloudflareOAuthScope = tokens.scope;
    provider.cloudflareAuthMode = "oauth";
    provider.cloudflareAccounts = accounts;
    provider.cloudflareAccountId = accounts[0].id;
    provider.cloudflareAccountName = accounts[0].name;
    provider.connectionStatus = "connected";
    provider.lastConnectionTestAt = Date.now();
    provider.lastConnectionError = "";
    await this.saveSettings();
    await this.syncCloudflareCatalogs(false);
    new Notice(`Cloudflare connected: ${accounts[0].name}`);
  }

  async disconnectCloudflare(providerId: string) {
    const provider = this.settings.providers.find((p) => p.id === providerId);
    if (!provider || provider.type !== "cloudflare") return;
    if (provider.apiKey && provider.cloudflareAuthMode === "oauth") {
      try { await revokeCloudflareOAuth(this.settings.cloudflareOAuthClientId, provider.apiKey); } catch { /* local disconnect still succeeds */ }
    }
    provider.apiKey = "";
    provider.cloudflareOAuthRefreshToken = "";
    provider.cloudflareOAuthExpiresAt = undefined;
    provider.cloudflareOAuthScope = "";
    provider.cloudflareAuthMode = "token";
    provider.connectionStatus = "unknown";
    provider.cloudflareAccountName = "";
    provider.cloudflareAccounts = [];
    await this.saveSettings();
  }

  async syncCloudflareCatalogs(showNotice = true) {
    const providers = this.settings.providers.filter((p) => p.type === "cloudflare");
    for (const provider of providers) {
      try {
        await this.ensureCloudflareAccessToken(provider.id);
        const models = await fetchCloudflareModels(provider);
        this.settings.modelCatalogs[provider.id] = {
          providerId: provider.id,
          providerType: provider.type,
          syncedAt: Date.now(),
          expiresAt: cacheExpiry(),
          models,
        };
        provider.connectionStatus = "connected";
        provider.lastConnectionTestAt = Date.now();
        provider.lastConnectionError = "";
        if (models.length && !models.some((m) => m.id === provider.model)) provider.model = models[0].id;
      } catch (e: any) {
        provider.connectionStatus = "error";
        provider.lastConnectionError = e?.message ?? String(e);
        this.settings.modelCatalogs[provider.id] = {
          providerId: provider.id, providerType: provider.type, syncedAt: Date.now(), expiresAt: Date.now() + 60 * 60 * 1000, models: this.settings.modelCatalogs[provider.id]?.models ?? [], error: provider.lastConnectionError,
        };
        if (showNotice) new Notice(`Cloudflare sync failed: ${provider.lastConnectionError}`);
      }
    }
    await this.saveSettings();
    if (showNotice) new Notice("Cloudflare model catalog synced.");
    this.activeChatPanel?.refreshProviderLabel();
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

  /**
   * Debounced so a drag-select fires once, when the pointer settles, rather
   * than on every intermediate mouseup.
   */
  private scheduleSelectionAI(event: MouseEvent | KeyboardEvent) {
    if (!this.settings.contextualAutoShow) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.(".agenter-root, .agenter-ctx, .menu, .modal-container")) return;
    if (this.selectionTimer !== null) window.clearTimeout(this.selectionTimer);
    this.selectionTimer = window.setTimeout(() => {
      this.selectionTimer = null;
      const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
      const selection = editor?.getSelection?.().trim() ?? "";
      if (!selection) {
        SelectionPopover.closeCurrent();
        return;
      }
      // Auto-show must not steal the caret while the user is still working.
      this.showSelectionAI(editor, selection, event, false);
    }, 90);
  }

  /**
   * Contextual third chat mode. The caret point is only consulted when the
   * popover is set to follow the selection; a pinned popover ignores it.
   */
  showSelectionAI(
    editor: Editor | undefined,
    selection: string,
    event?: MouseEvent | KeyboardEvent,
    focus = true
  ) {
    const caret = this.caretPoint(editor, event);
    const popover = openSelectionPopover(this, selection, caret);
    if (focus) popover?.focus();
  }

  /** Bottom-left of the selection end, falling back to the pointer. */
  private caretPoint(
    editor: Editor | undefined,
    event?: MouseEvent | KeyboardEvent
  ): { x: number; y: number } | undefined {
    const coords = (editor as EditorWithCoords | undefined)?.cursorCoords?.(false, "window");
    if (coords) return { x: coords.left, y: coords.bottom };
    if (event instanceof MouseEvent) return { x: event.clientX, y: event.clientY };
    return undefined;
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
