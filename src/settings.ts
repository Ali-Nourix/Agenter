import { App, PluginSettingTab, Setting, Notice, Modal } from "obsidian";
import AgenterPlugin from "../main";
import { probeModels } from "./api";

import { ProviderType, ModelCatalogCache, ModelMetadata } from "./provider-types";

export interface ProviderConfig {
  /** Unique id */
  id: string;
  /** Display name */
  name: string;
  /** Provider kind */
  type: ProviderType;
  /** Base URL, e.g. https://api.openai.com/v1 or a custom endpoint */
  baseUrl: string;
  /** API key */
  apiKey: string;
  /** Default model for this provider */
  model: string;
  /** Extra headers (JSON), used for custom providers */
  extraHeaders: string;
  /** Whether the provider supports native web search tool */
  supportsWebSearch: boolean;
  /** Whether the provider supports vision (image input) */
  supportsVision: boolean;
  cloudflareAccountId?: string;
  connectionStatus?: "unknown" | "connected" | "error";
  lastConnectionTestAt?: number;
  lastConnectionError?: string;
  cloudflareAuthMode?: "token" | "oauth";
  cloudflareOAuthRefreshToken?: string;
  cloudflareOAuthExpiresAt?: number;
  cloudflareOAuthScope?: string;
  cloudflareAccountName?: string;
  cloudflareAccounts?: Array<{ id: string; name: string }>;
  cloudflareModelTask?: string;
}

export interface StoredMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  /** For tool messages: the tool name (for display grouping) */
  toolName?: string;
}

/** A single named conversation the user can switch between. */
export interface ChatSession {
  /** Unique id */
  id: string;
  /** Display title (auto-derived from first user message, editable) */
  title: string;
  /** Unix ms of creation */
  createdAt: number;
  /** Unix ms of last activity (for sorting) */
  updatedAt: number;
  /** The persisted messages for this session */
  messages: StoredMessage[];
}

export interface AgentSettings {
  /** All configured providers */
  providers: ProviderConfig[];
  /** Currently selected provider id */
  activeProviderId: string;
  /** Max tokens for a completion */
  maxTokens: number;
  /** Temperature */
  temperature: number;
  /** System prompt */
  systemPrompt: string;
  /** Enable streaming */
  streaming: boolean;
  /** Default context scope: "note" | "folder" | "vault" | "none" */
  defaultContextScope: "note" | "folder" | "vault" | "none";
  /** Number of notes to include when summarizing folder/vault (0 = all) */
  maxContextNotes: number;
  /** Floating panel width */
  panelWidth: number;
  /** Floating panel height */
  panelHeight: number;
  /** Persisted conversation history (role/content pairs) — legacy, migrated to sessions. */
  chatHistory: StoredMessage[];
  /** All saved chat sessions (newest activity first when sorted). */
  sessions: ChatSession[];
  /** Id of the currently active session. */
  activeSessionId: string;
  /** Custom slash prompts, keyed without the leading slash. */
  customPrompts: Record<string, string>;
  /**
   * Which mutating tools require the user to approve before they run.
   * When a tool in this set is requested, the panel shows an inline
   * action card ("Append to note?") with Approve / Reject buttons.
   */
  toolApproval: Record<string, boolean>;
  modelCatalogs: Record<string, ModelCatalogCache>;
  favoriteModels: string[];
  pinnedModels: string[];
  recentModels: string[];
  cloudflareAutoSync: boolean;
  cloudflareCacheTtlHours: number;
  cloudflareDeveloperMode: boolean;
  cloudflareJsonMode: boolean;
  cloudflareOAuthClientId: string;
  modelOptions: Record<string, Record<string, string | number | boolean>>;
}

export const DEFAULT_SETTINGS: AgentSettings = {
  providers: [
    {
      id: "openai-default",
      name: "OpenAI",
      type: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o",
      extraHeaders: "",
      supportsWebSearch: true,
      supportsVision: true,
    },
    {
      id: "anthropic-default",
      name: "Anthropic",
      type: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "",
      model: "claude-3-5-sonnet-latest",
      extraHeaders: "",
      supportsWebSearch: false,
      supportsVision: true,
    },
    {
      id: "gemini-default",
      name: "Gemini",
      type: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "",
      model: "gemini-1.5-pro",
      extraHeaders: "",
      supportsWebSearch: true,
      supportsVision: true,
    },
    {
      id: "openrouter-default",
      name: "OpenRouter",
      type: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "",
      model: "openai/gpt-4o-mini",
      extraHeaders: "",
      supportsWebSearch: false,
      supportsVision: true,
    },
    {
      id: "ollama-default",
      name: "Ollama",
      type: "ollama",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "ollama",
      model: "llama3.1",
      extraHeaders: "",
      supportsWebSearch: false,
      supportsVision: false,
    },
    {
      id: "cloudflare-default",
      name: "Cloudflare Workers AI",
      type: "cloudflare",
      baseUrl: "",
      apiKey: "",
      model: "@cf/meta/llama-3.1-8b-instruct",
      extraHeaders: "",
      supportsWebSearch: false,
      supportsVision: true,
      cloudflareAccountId: "",
      connectionStatus: "unknown",
    },
    {
      id: "openai-compatible-default",
      name: "OpenAI-Compatible (DeepSeek/Qwen/OpenRouter…)",
      type: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "deepseek-chat",
      extraHeaders: "",
      supportsWebSearch: false,
      supportsVision: false,
    },
  ],
  activeProviderId: "openai-default",
  maxTokens: 4096,
  temperature: 0.7,
  systemPrompt:
    "You are Agenter, a helpful AI assistant embedded in Obsidian.\n\n" +
    "You have tools to read sections and metadata, inspect links/tags/folders, write and safely edit notes, move notes to recoverable Trash, search the vault and web, fetch public URLs, inspect plugins, and analyze note images. All file tools are strictly limited to the Obsidian vault. Use tools whenever the request requires workspace data.\n\n" +
    "## Tool guidance\n" +
    "- To refer to \"this note\" / \"the current note\", call `current_note`.\n" +
    "- Prefer `append_note` when the user wants to add content to the end of a note, `edit_note` for a targeted change, and `write_note` only to create a new note or when a full overwrite is explicitly requested.\n" +
    "- Before writing, briefly tell the user what you are about to do in one short sentence (e.g. \"I'll append these three bullet points to Daily/2026-07-16.md\").\n" +
    "- All mutations should be deliberate. Never claim a change happened before its tool succeeds. `trash_note` is recoverable, always requires confirmation, and must never be used unless the user clearly asked to remove that exact note.\n" +
    "- Prefer `read_note_section`, `note_metadata`, and `note_links` over reading a whole long note when sufficient.\n" +
    "- File paths must be relative to the vault. Never attempt filesystem, shell, or paths outside the vault.\n" +
    "- When you edit notes, preserve existing content unless asked to change it.\n\n" +
    "## Style\n" +
    "- Answer in the user's language. Be concise. Use markdown: headings, **bold**, lists, and fenced code blocks with a language tag.",
  streaming: true,
  defaultContextScope: "note",
  maxContextNotes: 20,
  panelWidth: 420,
  panelHeight: 600,
  chatHistory: [],
  sessions: [],
  activeSessionId: "",
  customPrompts: {
    summarize: "Summarize the selected text or current note with clear headings and action items.",
    rewrite: "Rewrite the selected text to be clearer, concise, and natural while preserving meaning.",
    extract: "Extract tasks, dates, names, decisions, and open questions from the selected text.",
  },
  modelCatalogs: {},
  favoriteModels: [],
  pinnedModels: [],
  recentModels: [],
  cloudflareAutoSync: true,
  cloudflareCacheTtlHours: 12,
  cloudflareDeveloperMode: false,
  cloudflareJsonMode: false,
  cloudflareOAuthClientId: "",
  modelOptions: {},
  toolApproval: {
    write_note: true,
    edit_note: true,
    append_note: true,
    read_note: false,
    search_notes: false,
    list_notes: false,
    summarize_note: false,
    get_note_images: false,
    web_search: false,
    current_note: false,
    list_plugins: false,
    plugin_info: false,
    fetch_url: false,
    find_images: false,
    read_note_section: false,
    note_metadata: false,
    note_links: false,
    list_folders: false,
    create_folder: true,
    move_note: true,
    trash_note: true,
  },
};

export function getActiveProvider(settings: AgentSettings): ProviderConfig | undefined {
  return settings.providers.find((p) => p.id === settings.activeProviderId);
}

/** Generate a reasonably-unique id without relying on Date.now/Math.random restrictions. */
export function genId(prefix = "s"): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/** Derive a short session title from its first user message. */
export function deriveTitle(messages: StoredMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const raw = (firstUser?.content ?? "").trim().replace(/\s+/g, " ");
  if (!raw) return "New chat";
  return raw.length > 42 ? raw.slice(0, 42) + "…" : raw;
}

/** Return the active session, creating one if none exists. */
export function getActiveSession(settings: AgentSettings): ChatSession {
  let session = settings.sessions.find((s) => s.id === settings.activeSessionId);
  if (!session) {
    session = {
      id: genId(),
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    settings.sessions.unshift(session);
    settings.activeSessionId = session.id;
  }
  return session;
}

export class AgentSettingTab extends PluginSettingTab {
  plugin: AgenterPlugin;
  private activeSection: "providers" | "chat" | "tools" | "advanced" = "providers";

  constructor(app: App, plugin: AgenterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("agenter-settings-shell");

    const active = getActiveProvider(this.plugin.settings);
    const cloudflare = this.plugin.settings.providers.find((p) => p.type === "cloudflare");
    const hero = containerEl.createDiv({ cls: "agenter-settings-hero" });
    const heroText = hero.createDiv({ cls: "agenter-settings-hero-copy" });
    new Setting(heroText).setName("General").setDesc("Agenter").setHeading();
    const heroStatus = hero.createDiv({ cls: "agenter-settings-hero-status" });
    heroStatus.createEl("span", { cls: `agenter-status-dot ${active?.apiKey ? "is-online" : ""}` });
    const statusCopy = heroStatus.createDiv();
    statusCopy.createEl("strong", { text: active?.name ?? "No provider" });
    statusCopy.createEl("small", { text: active?.model ?? "Choose a provider to begin" });

    const nav = containerEl.createDiv({ cls: "agenter-settings-nav", attr: { role: "tablist", "aria-label": "Agenter settings" } });
    const content = containerEl.createDiv({ cls: "agenter-settings-content" });
    const panes = {
      providers: content.createDiv({ cls: "agenter-settings-pane" }),
      chat: content.createDiv({ cls: "agenter-settings-pane" }),
      tools: content.createDiv({ cls: "agenter-settings-pane" }),
      advanced: content.createDiv({ cls: "agenter-settings-pane" }),
    };
    const tabDefs = [
      { id: "providers" as const, label: "Providers" },
      { id: "chat" as const, label: "Chat" },
      { id: "tools" as const, label: "Tools" },
      { id: "advanced" as const, label: "Advanced" },
    ];
    const renderTabs = () => {
      for (const def of tabDefs) {
        const pane = panes[def.id];
        pane.toggleClass("is-active", this.activeSection === def.id);
      }
      nav.querySelectorAll("button").forEach((button) => {
        const selected = (button as HTMLElement).dataset.section === this.activeSection;
        button.toggleClass("is-active", selected);
        button.setAttribute("aria-selected", String(selected));
      });
    };
    for (const def of tabDefs) {
      const button = nav.createEl("button", { cls: "agenter-settings-tab", attr: { type: "button", role: "tab" } });
      button.dataset.section = def.id;
      button.createEl("span", { text: def.label });
      button.addEventListener("click", () => { this.activeSection = def.id; renderTabs(); });
    }
    renderTabs();

    const providersPane = panes.providers;
    const chatPane = panes.chat;
    const toolsPane = panes.tools;
    const advancedPane = panes.advanced;

    // --- Providers ---
    new Setting(providersPane).setName("Providers").setHeading();

    new Setting(providersPane)
      .setName("Active provider")
      .setDesc("Select which provider/model to use for chat.")
      .addDropdown((dd) => {
        this.plugin.settings.providers.forEach((p) => {
          dd.addOption(p.id, `${p.name} — ${p.model}`);
        });
        dd.setValue(this.plugin.settings.activeProviderId);
        dd.onChange(async (value) => {
          this.plugin.settings.activeProviderId = value;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    this.plugin.settings.providers
      .filter((provider) => provider.id === this.plugin.settings.activeProviderId)
      .forEach((provider) => {
      const wrapper = providersPane.createDiv({ cls: "agenter-provider-block" });
      wrapper.setCssStyles({
        border: "1px solid var(--background-modifier-border)",
        borderRadius: "8px",
        padding: "12px",
        marginBottom: "12px",
      });

      new Setting(wrapper)
        .setName(provider.name)
        .setDesc(`Type: ${provider.type}`)
        .addButton((btn) =>
          btn.setButtonText("Remove").onClick(async () => {
            this.plugin.settings.providers = this.plugin.settings.providers.filter(
              (p) => p.id !== provider.id
            );
            if (this.plugin.settings.activeProviderId === provider.id) {
              this.plugin.settings.activeProviderId =
                this.plugin.settings.providers[0]?.id ?? "";
            }
            await this.plugin.saveSettings();
            this.display();
          })
        )
        .addButton((btn) =>
          btn.setButtonText("Test").onClick(async () => {
            btn.setDisabled(true);
            btn.setButtonText("Testing…");
            const res = await probeModels(provider);
            btn.setDisabled(false);
            btn.setButtonText("Test");
            if (!res.ok) {
              new Notice(`❌ ${provider.name}: ${res.error ?? "failed"}`);
              return;
            }
            const found = res.models.includes(provider.model);
            if (found) {
              new Notice(`✅ ${provider.name}: connected, model "${provider.model}" OK`);
            } else if (res.models.length) {
              new Notice(
                `⚠️ ${provider.name}: connected, but "${provider.model}" not in list (${res.models.length} models available)`
              );
            } else {
              new Notice(`✅ ${provider.name}: connected`);
            }
          })
        );

      if (provider.type !== "cloudflare") {
      new Setting(wrapper).setName("Display name").addText((t) =>
        t.setValue(provider.name).onChange(async (v) => {
          provider.name = v;
          await this.plugin.saveSettings();
        })
      );

      new Setting(wrapper).setName("Type").addDropdown((dd) => {
        dd.addOption("openai", "OpenAI");
        dd.addOption("openai-compatible", "OpenAI-Compatible");
        dd.addOption("anthropic", "Anthropic");
        dd.addOption("gemini", "Gemini");
        dd.addOption("openrouter", "OpenRouter");
        dd.addOption("ollama", "Ollama");
        dd.addOption("cloudflare", "Cloudflare Workers AI");
        dd.addOption("custom", "Custom");
        dd.setValue(provider.type);
        dd.onChange(async (v) => {
          provider.type = v as ProviderType;
          await this.plugin.saveSettings();
          this.display();
        });
      });

      new Setting(wrapper).setName("Base URL").addText((t) =>
        t.setValue(provider.baseUrl).onChange(async (v) => {
          provider.baseUrl = v;
          await this.plugin.saveSettings();
        })
      );

      }

      if (provider.type !== "cloudflare") {
        new Setting(wrapper).setName("API key").addText((t) => {
          t.inputEl.type = "password";
          t.setValue(provider.apiKey).onChange(async (v) => {
            provider.apiKey = v;
            await this.plugin.saveSettings();
          });
        });
      }

      if (provider.type === "cloudflare") {
        const cloudflareConnected = !!provider.apiKey && !!provider.cloudflareAccountId && provider.connectionStatus === "connected";
        const oauthConnected = provider.cloudflareAuthMode === "oauth" && cloudflareConnected;
        const authCard = wrapper.createDiv({ cls: "agenter-cf-connect-card" });
        authCard.createEl("div", { cls: "agenter-cf-connect-logo", text: "☁" });
        const authCopy = authCard.createDiv({ cls: "agenter-cf-connect-copy" });
        authCopy.createEl("strong", { text: cloudflareConnected ? "Workers AI connected" : "Set up Workers AI" });
        authCopy.createEl("span", { text: cloudflareConnected
          ? `${provider.cloudflareAccountName ?? provider.cloudflareAccountId} · ${provider.cloudflareAuthMode === "oauth" ? "OAuth" : "Official API token"}`
          : "Use Cloudflare's official Workers AI REST API setup. Includes 10,000 free Neurons every day." });
        const authButton = authCard.createEl("button", { text: cloudflareConnected ? "Disconnect" : "Set up" });
        authButton.addClass(cloudflareConnected ? "is-disconnect" : "mod-cta");
        authButton.addEventListener("click", async () => {
          if (cloudflareConnected) {
            authButton.disabled = true;
            authButton.textContent = "Disconnecting…";
            await this.plugin.disconnectCloudflare(provider.id);
            this.display();
            return;
          }
          new CloudflareWorkersSetupModal(this.app, this.plugin, provider, () => this.display()).open();
        });

        if (oauthConnected && (provider.cloudflareAccounts?.length ?? 0) > 1) {
          new Setting(wrapper).setName("Cloudflare account").setDesc("Choose which authorized account Workers AI should use.").addDropdown((dd) => {
            for (const account of provider.cloudflareAccounts ?? []) dd.addOption(account.id, account.name);
            dd.setValue(provider.cloudflareAccountId ?? "");
            dd.onChange(async (id) => {
              provider.cloudflareAccountId = id;
              provider.cloudflareAccountName = provider.cloudflareAccounts?.find((a) => a.id === id)?.name;
              await this.plugin.saveSettings();
              await this.plugin.syncCloudflareCatalogs(false);
              this.display();
            });
          });
        } else if (!oauthConnected && this.plugin.settings.cloudflareDeveloperMode) {
          new Setting(wrapper).setName("Cloudflare Account ID").setDesc("Only needed for manual API-token mode. OAuth discovers this automatically.").addText((t) =>
            t.setValue(provider.cloudflareAccountId ?? "").onChange(async (v) => {
              provider.cloudflareAccountId = v.trim();
              await this.plugin.saveSettings();
            })
          );
        }
        const cache = this.plugin.settings.modelCatalogs?.[provider.id];
        const status = provider.connectionStatus === "connected" ? "✅ Connected" : provider.connectionStatus === "error" ? `❌ ${provider.lastConnectionError ?? "Error"}` : "Not tested";
        new Setting(wrapper).setName("Connection status").setDesc(`${status}${cache?.syncedAt ? ` · Synced ${new Date(cache.syncedAt).toLocaleString()} · ${cache.models.length} models cached` : ""}`)
          .addButton((btn) => btn.setButtonText("Sync catalog").onClick(async () => {
            btn.setDisabled(true); btn.setButtonText("Syncing…");
            await this.plugin.syncCloudflareCatalogs(true);
            btn.setDisabled(false); this.display();
          }));

      }

      // --- Model: dropdown populated by "Fetch models" ---
      let modelDD: any;
      const modelSetting = new Setting(wrapper).setName("Model");
      modelSetting.addDropdown((dd) => {
        modelDD = dd;
        const cachedModels = this.plugin.settings.modelCatalogs?.[provider.id]?.models ?? [];
        if (provider.type === "cloudflare" && cachedModels.length) {
          for (const model of cachedModels) dd.addOption(model.id, model.name || model.id);
        } else {
          dd.addOption(provider.model, provider.model);
        }
        if (!cachedModels.some((model) => model.id === provider.model)) dd.addOption(provider.model, provider.model);
        dd.setValue(provider.model);
        dd.onChange(async (v) => {
          provider.model = v;
          if (provider.type === "cloudflare") {
            const selected = cachedModels.find((model) => model.id === v);
            provider.cloudflareModelTask = selected?.task ?? String((selected?.raw as any)?.task?.name ?? (selected?.raw as any)?.task ?? "");
          }
          await this.plugin.saveSettings();
        });
      });
      modelSetting.addButton((btn) =>
        btn.setButtonText("Fetch models").onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("Fetching…");
          if (provider.type === "cloudflare") {
            await this.plugin.syncCloudflareCatalogs(true);
            this.display();
            return;
          }
          const res = await probeModels(provider);
          btn.setDisabled(false);
          btn.setButtonText("Fetch models");
          if (!res.ok) {
            new Notice(`❌ ${provider.name}: ${res.error ?? "failed"}`);
            return;
          }
          if (!res.models.length) {
            new Notice(`✅ ${provider.name}: connected (no model list)`);
            return;
          }
          // rebuild dropdown options
          modelDD.selectEl.empty();
          for (const m of res.models) modelDD.addOption(m, m);
          if (res.models.includes(provider.model)) modelDD.setValue(provider.model);
          else modelDD.setValue(res.models[0]);
          new Notice(`✅ ${provider.name}: ${res.models.length} models loaded`);
        })
      );

      if (provider.type !== "cloudflare") {
        new Setting(wrapper).setName("Supports web search").addToggle((tg) =>
          tg.setValue(provider.supportsWebSearch).onChange(async (v) => {
            provider.supportsWebSearch = v;
            await this.plugin.saveSettings();
          })
        );
        new Setting(wrapper).setName("Supports vision").addToggle((tg) =>
          tg.setValue(provider.supportsVision).onChange(async (v) => {
            provider.supportsVision = v;
            await this.plugin.saveSettings();
          })
        );
      }
    });

    const addProviderSetting = new Setting(providersPane).setName("Add provider").addButton((btn) =>
      btn.setButtonText("+ Add provider").onClick(() => {
        new ProviderModal(this.app, this.plugin, (provider) => {
          this.plugin.settings.providers.push(provider);
          void this.plugin.saveSettings();
          this.display();
        }).open();
      })
    );
    addProviderSetting.settingEl.addClass("agenter-add-provider-setting");

    // --- Chat behavior ---
    new Setting(chatPane).setName("Chat behavior").setHeading();

    new Setting(chatPane)
      .setName("Default context scope")
      .setDesc("What notes to include in context by default.")
      .addDropdown((dd) => {
        dd.addOption("note", "Current note");
        dd.addOption("folder", "Current folder");
        dd.addOption("vault", "Whole vault");
        dd.addOption("none", "None");
        dd.setValue(this.plugin.settings.defaultContextScope);
        dd.onChange(async (v) => {
          this.plugin.settings.defaultContextScope = v as any;
          await this.plugin.saveSettings();
        });
      });

    new Setting(chatPane)
      .setName("Max context notes")
      .setDesc("0 = include all notes in folder/vault scope.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxContextNotes)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.maxContextNotes = isNaN(n) ? 0 : n;
          await this.plugin.saveSettings();
        })
      );

    new Setting(chatPane)
      .setName("Max tokens")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxTokens)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.maxTokens = isNaN(n) ? 4096 : n;
          await this.plugin.saveSettings();
        })
      );

    new Setting(chatPane)
      .setName("Temperature")
      .addSlider((s) =>
        s
          .setLimits(0, 2, 0.1)
          .setValue(this.plugin.settings.temperature)
          .onChange(async (v) => {
            this.plugin.settings.temperature = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(chatPane).setName("Streaming").addToggle((tg) =>
      tg.setValue(this.plugin.settings.streaming).onChange(async (v) => {
        this.plugin.settings.streaming = v;
        await this.plugin.saveSettings();
      })
    );

    new Setting(chatPane)
      .setName("System prompt")
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.systemPrompt);
        t.inputEl.rows = 4;
        t.onChange(async (v) => {
          this.plugin.settings.systemPrompt = v;
          await this.plugin.saveSettings();
        });
      });

    // --- Custom prompt builder (form-based, no JSON required) ---
    new Setting(toolsPane).setName("Custom prompts").setHeading();
    toolsPane.createEl("p", {
      text:
        "Build your own reusable prompts (like Summarize or Rewrite). They appear in the chat / menu and beside selected text. Use {{selection}} where the selected text should go; if omitted, the selection is appended automatically.",
      cls: "setting-item-description",
    });
    this.renderPromptBuilder(toolsPane.createDiv({ cls: "agenter-prompt-builder" }));

    // --- Tool approval ---
    new Setting(toolsPane).setName("Tool approval").setHeading();
    toolsPane.createEl("p", {
      text:
        "Mutating tools pause and show a preview before they run. Moving a note to Trash always requires a two-step confirmation and cannot be disabled. Every note mutation also creates a recoverable safety backup inside the vault.",
      cls: "setting-item-description",
    });

    const APPROVABLE: { key: string; label: string }[] = [
      { key: "write_note", label: "Create / overwrite a note" },
      { key: "edit_note", label: "Edit a note (find & replace)" },
      { key: "append_note", label: "Append to a note" },
      { key: "create_folder", label: "Create a vault folder" },
      { key: "move_note", label: "Move / rename a note" },
      { key: "trash_note", label: "Move a note to recoverable Trash (always confirmed)" },
    ];
    for (const t of APPROVABLE) {
      new Setting(toolsPane)
        .setName(t.label)
        .setDesc(`Tool: ${t.key}`)
        .addToggle((tg) =>
          tg
            .setValue(this.plugin.settings.toolApproval?.[t.key] ?? true)
            .onChange(async (v) => {
              if (!this.plugin.settings.toolApproval) this.plugin.settings.toolApproval = {};
              this.plugin.settings.toolApproval[t.key] = v;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(advancedPane).setName("Cloudflare").setHeading();
    new Setting(advancedPane)
      .setName("Automatic model sync")
      .setDesc("Refresh the Workers AI model catalog when Agenter starts.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.cloudflareAutoSync)
        .onChange(async (value) => {
          this.plugin.settings.cloudflareAutoSync = value;
          await this.plugin.saveSettings();
        }));

    const diag = advancedPane.createDiv({ cls: "agenter-diagnostics-card" });
    diag.createEl("strong", { text: "Cloudflare diagnostics" });
    diag.createEl("span", { text: cloudflare?.connectionStatus === "connected" ? "Connected" : "Not connected" });
    diag.createEl("code", { text: cloudflare?.cloudflareAccountName ?? cloudflare?.cloudflareAccountId ?? "No account selected" });
  }

  private renderPromptBuilder(host: HTMLElement) {
    host.empty();
    const prompts = this.plugin.settings.customPrompts ?? {};
    const keys = Object.keys(prompts);
    if (!keys.length) {
      host.createEl("p", {
        text: "No custom prompts yet. Add your first one below.",
        cls: "setting-item-description",
      });
    }
    for (const key of keys) {
      const card = host.createDiv({ cls: "agenter-prompt-card" });
      const nameSetting = new Setting(card).setName(key);
      nameSetting.addExtraButton((b) =>
        b
          .setIcon("pencil")
          .setTooltip("Rename")
          .onClick(() => this.promptEditModal(key, prompts[key], host))
      );
      nameSetting.addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip("Delete")
          .onClick(async () => {
            delete this.plugin.settings.customPrompts[key];
            await this.plugin.saveSettings();
            this.renderPromptBuilder(host);
          })
      );
      const body = new Setting(card).setClass("agenter-prompt-card-body");
      body.addTextArea((t) => {
        t.setValue(prompts[key]);
        t.inputEl.rows = 3;
        t.inputEl.addClass("agenter-prompt-textarea");
        t.onChange(async (v) => {
          this.plugin.settings.customPrompts[key] = v;
          await this.plugin.saveSettings();
        });
      });
    }
    new Setting(host).addButton((b) =>
      b
        .setButtonText("+ Add custom prompt")
        .setCta()
        .onClick(() => this.promptEditModal("", "", host))
    );
  }

  private promptEditModal(originalKey: string, value: string, host: HTMLElement) {
    const modal = new Modal(this.app);
    modal.titleEl.setText(originalKey ? "Edit prompt" : "New prompt");
    const { contentEl } = modal;
    let name = originalKey;
    let text = value;
    new Setting(contentEl)
      .setName("Name")
      .setDesc("Short label, e.g. Translate to English")
      .addText((t) =>
        t
          .setPlaceholder("My prompt")
          .setValue(name)
          .onChange((v) => (name = v))
      );
    new Setting(contentEl)
      .setName("Prompt")
      .setDesc("Use {{selection}} to place selected text. Otherwise it is appended.")
      .addTextArea((t) => {
        t.setPlaceholder("Summarize the following text in 3 bullet points:\n\n{{selection}}");
        t.setValue(text);
        t.inputEl.rows = 6;
        t.inputEl.addClass("agenter-prompt-textarea");
        t.onChange((v) => (text = v));
      });
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Save")
        .setCta()
        .onClick(async () => {
          const cleanName = name.trim();
          if (!cleanName) {
            new Notice("Please enter a name for the prompt.");
            return;
          }
          if (!this.plugin.settings.customPrompts) this.plugin.settings.customPrompts = {};
          if (originalKey && originalKey !== cleanName) {
            delete this.plugin.settings.customPrompts[originalKey];
          }
          this.plugin.settings.customPrompts[cleanName] = text;
          await this.plugin.saveSettings();
          modal.close();
          this.renderPromptBuilder(host);
        })
    );
    modal.open();
  }
}

class CloudflareWorkersSetupModal extends Modal {
  constructor(
    app: App,
    private plugin: AgenterPlugin,
    private provider: ProviderConfig,
    private onConnected: () => void
  ) { super(app); }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("agenter-cf-setup-modal");
    this.titleEl.setText("Connect Cloudflare Workers AI");
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Cloudflare's official REST API uses an Account ID and Workers AI API token. The Free plan includes 10,000 Neurons per day.",
    });
    const free = contentEl.createDiv({ cls: "agenter-cf-free-note" });
    free.createEl("strong", { text: "10,000 Neurons/day free" });
    free.createEl("span", { text: "Requests stop at the free limit unless the account uses Workers Paid." });

    let accountId = this.provider.cloudflareAccountId ?? "";
    let token = this.provider.cloudflareAuthMode === "token" ? this.provider.apiKey : "";
    const status = contentEl.createEl("p", { cls: "agenter-cf-setup-status" });

    new Setting(contentEl)
      .setName("1. Create Workers AI token")
      .setDesc("Cloudflare pre-fills the required Workers AI permissions.")
      .addButton((button) => button.setButtonText("Open Cloudflare Workers AI").setCta().onClick(() => {
        window.open("https://dash.cloudflare.com/?to=/:account/ai/workers-ai", "_blank");
      }));
    new Setting(contentEl)
      .setName("2. Account ID")
      .setDesc("Copy it from Workers AI → Use REST API.")
      .addText((input) => input.setPlaceholder("32-character Account ID").setValue(accountId).onChange((value) => accountId = value.trim()));
    new Setting(contentEl)
      .setName("3. API token")
      .setDesc("Create a Workers AI API Token, then paste it here.")
      .addText((input) => {
        input.inputEl.type = "password";
        input.setPlaceholder("Cloudflare Workers AI API token").setValue(token).onChange((value) => token = value.trim());
      });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Verify and connect").setCta().onClick(async () => {
        if (!accountId || !token) { status.setText("Enter both Account ID and API token."); return; }
        button.setDisabled(true);
        button.setButtonText("Checking Workers AI…");
        status.setText("Verifying credentials and loading the live model catalog…");
        try {
          const count = await this.plugin.connectCloudflareToken(this.provider.id, accountId, token);
          status.setText(`Connected. ${count} Workers AI models loaded.`);
          new Notice(`Cloudflare Workers AI connected · ${count} models`);
          this.onConnected();
          window.setTimeout(() => this.close(), 500);
        } catch (error: any) {
          status.setText(error?.message ?? String(error));
          button.setDisabled(false);
          button.setButtonText("Verify and connect");
        }
      }));
  }

  onClose() { this.contentEl.empty(); }
}

class ProviderModal extends Modal {
  plugin: AgenterPlugin;
  onSubmit: (provider: ProviderConfig) => void;

  constructor(app: App, plugin: AgenterPlugin, onSubmit: (provider: ProviderConfig) => void) {
    super(app);
    this.plugin = plugin;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    new Setting(contentEl).setName("Add provider").setHeading();

    const vals: ProviderConfig = {
      id: "tmp",
      name: "New Provider",
      type: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o",
      extraHeaders: "",
      supportsWebSearch: false,
      supportsVision: false,
    };

    new Setting(contentEl).setName("Name").addText((t) =>
      t.setValue(vals.name).onChange((v) => (vals.name = v))
    );
    new Setting(contentEl).setName("Type").addDropdown((dd) => {
      dd.addOption("openai", "OpenAI");
      dd.addOption("openai-compatible", "OpenAI-Compatible");
      dd.addOption("anthropic", "Anthropic");
      dd.addOption("gemini", "Gemini");
      dd.addOption("custom", "Custom");
      dd.setValue(vals.type);
      dd.onChange((v) => (vals.type = v as ProviderType));
    });
    new Setting(contentEl).setName("Base URL").addText((t) =>
      t.setValue(vals.baseUrl).onChange((v) => (vals.baseUrl = v))
    );
    new Setting(contentEl).setName("API key").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => (vals.apiKey = v));
    });
    new Setting(contentEl).setName("Model").addDropdown((dd) => {
      dd.addOption(vals.model, vals.model);
      dd.setValue(vals.model);
      dd.onChange((v) => (vals.model = v));
      (contentEl as any)._modelDD = dd;
    }).addButton((btn) =>
      btn.setButtonText("Fetch models").onClick(async () => {
        btn.setDisabled(true);
        btn.setButtonText("Fetching…");
        const res = await probeModels(vals);
        btn.setDisabled(false);
        btn.setButtonText("Fetch models");
        if (!res.ok) {
          status.setText(`❌ ${res.error ?? "Connection failed"}`);
          return;
        }
        if (!res.models.length) {
          status.setText(`✅ Connected (no model list)`);
          return;
        }
        const dd = (contentEl as any)._modelDD;
        dd.selectEl.empty();
        for (const m of res.models) dd.addOption(m, m);
        if (res.models.includes(vals.model)) dd.setValue(vals.model);
        else dd.setValue(res.models[0]);
        vals.model = res.models.includes(vals.model) ? vals.model : res.models[0];
        status.setText(`✅ ${res.models.length} models loaded. Pick one above.`);
      })
    );

    const status = contentEl.createEl("p");
    status.setCssStyles({ fontSize: "12px", opacity: "0.8" });

    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText("Test connection & fetch models").onClick(async () => {
        btn.setDisabled(true);
        status.setText("Testing…");
        const res = await probeModels(vals);
        if (!res.ok) {
          status.setText(`❌ ${res.error ?? "Connection failed"}`);
          btn.setDisabled(false);
          return;
        }
        const found = res.models.includes(vals.model);
        if (found) {
          status.setText(`✅ Connected. Model "${vals.model}" is available.`);
        } else if (res.models.length) {
          status.setText(
            `⚠️ Connected, but model "${vals.model}" not in list. Available: ${res.models.slice(0, 8).join(", ")}${res.models.length > 8 ? "…" : ""}`
          );
        } else {
          status.setText(`✅ Connected (no model list returned).`);
        }
        btn.setDisabled(false);
      })
    );

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Add")
        .setCta()
        .onClick(() => {
          const id = "custom-" + Date.now().toString(36);
          this.onSubmit({
            ...vals,
            id,
            extraHeaders: vals.extraHeaders || "",
          });
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}
