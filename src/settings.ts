import { App, PluginSettingTab, Setting, Notice, Modal } from "obsidian";
import AgenterPlugin from "../main";
import { probeModels } from "./api";

export type ProviderType = "openai-compatible" | "openai" | "anthropic" | "gemini" | "custom";

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

  constructor(app: App, plugin: AgenterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- Providers ---
    new Setting(containerEl).setName("Providers").setHeading();

    new Setting(containerEl)
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

    this.plugin.settings.providers.forEach((provider) => {
      const wrapper = containerEl.createDiv({ cls: "agenter-provider-block" });
      wrapper.setCssStyles({
        border: "1px solid var(--background-modifier-border)",
        borderRadius: "8px",
        padding: "12px",
        marginBottom: "12px",
      });

      new Setting(wrapper)
        .setName(`Provider: ${provider.name}`)
        .setDesc(`Type: ${provider.type}`)
        .addButton((btn) =>
          btn.setButtonText("Remove").setDestructive().onClick(async () => {
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

      new Setting(wrapper).setName("API key").addText((t) => {
        t.inputEl.type = "password";
        t.setValue(provider.apiKey).onChange(async (v) => {
          provider.apiKey = v;
          await this.plugin.saveSettings();
        });
      });

      // --- Model: dropdown populated by "Fetch models" ---
      let modelDD: any;
      const modelSetting = new Setting(wrapper).setName("Model");
      modelSetting.addDropdown((dd) => {
        modelDD = dd;
        // seed with the current value so it's never empty
        dd.addOption(provider.model, provider.model);
        dd.setValue(provider.model);
        dd.onChange(async (v) => {
          provider.model = v;
          await this.plugin.saveSettings();
        });
      });
      modelSetting.addButton((btn) =>
        btn.setButtonText("Fetch models").onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("Fetching…");
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

      new Setting(wrapper)
        .setName("Extra headers (JSON)")
        .setDesc("Only for custom providers. e.g. {\"Authorization\":\"Bearer x\"}")
        .addTextArea((t) => {
          t.setValue(provider.extraHeaders);
          t.inputEl.rows = 2;
          t.onChange(async (v) => {
            provider.extraHeaders = v;
            await this.plugin.saveSettings();
          });
        });

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
    });

    new Setting(containerEl).setName("Add new provider").addButton((btn) =>
      btn.setButtonText("+ Add provider").onClick(() => {
        new ProviderModal(this.app, this.plugin, (provider) => {
          this.plugin.settings.providers.push(provider);
          void this.plugin.saveSettings();
          this.display();
        }).open();
      })
    );

    // --- Chat behavior ---
    new Setting(containerEl).setName("Chat behavior").setHeading();

    new Setting(containerEl)
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

    new Setting(containerEl)
      .setName("Max context notes")
      .setDesc("0 = include all notes in folder/vault scope.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxContextNotes)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.maxContextNotes = isNaN(n) ? 0 : n;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Max tokens")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxTokens)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.maxTokens = isNaN(n) ? 4096 : n;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
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

    new Setting(containerEl).setName("Streaming").addToggle((tg) =>
      tg.setValue(this.plugin.settings.streaming).onChange(async (v) => {
        this.plugin.settings.streaming = v;
        await this.plugin.saveSettings();
      })
    );

    new Setting(containerEl)
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
    new Setting(containerEl).setName("Custom prompts").setHeading();
    containerEl.createEl("p", {
      text:
        "Build your own reusable prompts (like Summarize or Rewrite). They appear in the chat / menu and beside selected text. Use {{selection}} where the selected text should go; if omitted, the selection is appended automatically.",
      cls: "setting-item-description",
    });
    this.renderPromptBuilder(containerEl.createDiv({ cls: "agenter-prompt-builder" }));

    // --- Tool approval ---
    new Setting(containerEl).setName("Tool approval").setHeading();
    containerEl.createEl("p", {
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
      new Setting(containerEl)
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
