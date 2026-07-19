var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  AGENTER_VIEW_TYPE: () => AGENTER_VIEW_TYPE,
  default: () => AgenterPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian5 = require("obsidian");

// src/settings.ts
var import_obsidian2 = require("obsidian");

// src/api.ts
var import_obsidian = require("obsidian");
var import_http = require("http");
var import_https = require("https");
async function* nativeNodeStream(url, headers, body) {
  const target = new URL(url);
  const requestFn = target.protocol === "http:" ? import_http.request : import_https.request;
  const response = await new Promise((resolve, reject) => {
    const req = requestFn(
      target,
      {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Length": Buffer.byteLength(body),
          ...headers
        }
      },
      resolve
    );
    req.once("error", reject);
    req.setTimeout(12e4, () => {
      req.destroy(new Error("Provider request timed out after 120 seconds."));
    });
    req.write(body);
    req.end();
  });
  if ((response.statusCode ?? 500) >= 400) {
    let errorBody = "";
    for await (const chunk of response) {
      errorBody += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (errorBody.length > 2e3) break;
    }
    throw new Error(
      `Provider error (${response.statusCode}): ${errorBody.slice(0, 500)}`
    );
  }
  let buffer = "";
  for await (const chunk of response) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      if (data) yield data;
    }
  }
  const trailing = buffer.trim();
  if (trailing.startsWith("data:")) {
    const data = trailing.slice(5).trim();
    if (data && data !== "[DONE]") yield data;
  }
}
async function* obsidianStream(url, headers, body) {
  const resp = await (0, import_obsidian.requestUrl)({
    url,
    method: "POST",
    headers,
    body,
    contentType: "application/json"
  });
  const raw = resp;
  if (raw.body && typeof raw.body.getReader === "function") {
    const reader = raw.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines2 = buffer.split("\n");
      buffer = lines2.pop() ?? "";
      for (const line of lines2) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        yield data;
      }
    }
    return;
  }
  const text = raw.text ?? "";
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") return;
    yield data;
    await new Promise((r) => setTimeout(r, 5));
  }
}
var BaseProvider = class {
  constructor(config, runtime = {}) {
    this.config = config;
    this.runtime = runtime;
  }
  getHeaders(extra = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...extra
    };
    if (this.config.extraHeaders) {
      try {
        const parsed = JSON.parse(this.config.extraHeaders);
        Object.assign(headers, parsed);
      } catch {
      }
    }
    return headers;
  }
  async *streamLines(body, url, headers) {
    let emitted = false;
    try {
      for await (const data of nativeNodeStream(url, headers, body)) {
        emitted = true;
        yield data;
      }
    } catch (error) {
      if (emitted || String(error?.message ?? error).includes("Provider error")) {
        throw error;
      }
      yield* obsidianStream(url, headers, body);
    }
  }
};
var OpenAIProvider = class extends BaseProvider {
  chat(messages, tools, cb) {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const headers = this.getHeaders({ Authorization: `Bearer ${this.config.apiKey}` });
    const payload = {
      model: this.config.model,
      messages: messages.map((m) => {
        if (m.role === "assistant" && m.tool_calls) {
          return {
            role: "assistant",
            content: m.content || null,
            tool_calls: m.tool_calls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments }
            }))
          };
        }
        if (m.role === "tool") {
          return {
            role: "tool",
            tool_call_id: m.tool_call_id,
            content: m.content
          };
        }
        return { role: m.role, content: m.content };
      }),
      stream: true,
      temperature: this.runtime.temperature,
      max_tokens: this.runtime.maxTokens
    };
    if (tools.length) {
      payload.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }));
      payload.tool_choice = "auto";
    }
    return this.runStream(url, headers, payload, cb);
  }
  async runStream(url, headers, payload, cb) {
    try {
      const collectedToolCalls = /* @__PURE__ */ new Map();
      const indexToKey = /* @__PURE__ */ new Map();
      for await (const data of this.streamLines(JSON.stringify(payload), url, headers)) {
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) cb.onToken(delta.content);
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const key = tc.id ?? (tc.index !== void 0 ? indexToKey.get(tc.index) ?? `index-${tc.index}` : "index-0");
            if (tc.index !== void 0) indexToKey.set(tc.index, key);
            const existing = collectedToolCalls.get(key) ?? { name: "", args: "" };
            if (tc.function?.name) existing.name = tc.function.name;
            if (existing && tc.function?.arguments) {
              existing.args += tc.function.arguments;
            }
            collectedToolCalls.set(key, existing);
          }
        }
      }
      if (collectedToolCalls.size) {
        const calls = Array.from(collectedToolCalls.entries()).map(([id, v]) => ({
          id,
          name: v.name,
          arguments: v.args
        }));
        cb.onToolCalls?.(calls);
      }
      cb.onDone();
    } catch (e) {
      cb.onError(e);
    }
  }
};
var AnthropicProvider = class extends BaseProvider {
  chat(messages, tools, cb) {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/messages`;
    const headers = this.getHeaders({
      "x-api-key": this.config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    });
    const sys = messages.filter((m) => m.role === "system").map((m) => m.content);
    const turns = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "user") {
        turns.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        if (m.tool_calls && m.tool_calls.length) {
          turns.push({
            role: "assistant",
            content: m.tool_calls.map((tc) => ({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: safeParse(tc.arguments)
            }))
          });
        } else {
          turns.push({ role: "assistant", content: m.content });
        }
      } else if (m.role === "tool") {
        turns.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m.tool_call_id,
              content: m.content
            }
          ]
        });
      }
    }
    const payload = {
      model: this.config.model,
      max_tokens: this.runtime.maxTokens ?? 4096,
      temperature: this.runtime.temperature,
      system: sys.join("\n"),
      messages: turns,
      stream: true
    };
    if (tools.length) {
      payload.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters
      }));
    }
    return this.runStream(url, headers, payload, cb);
  }
  async runStream(url, headers, payload, cb) {
    try {
      let textBuf = "";
      const toolUses = /* @__PURE__ */ new Map();
      const indexToKey = /* @__PURE__ */ new Map();
      for await (const data of this.streamLines(JSON.stringify(payload), url, headers)) {
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        switch (json.type) {
          case "content_block_delta":
            if (json.delta?.type === "text_delta") {
              textBuf += json.delta.text;
              cb.onToken(json.delta.text);
            } else if (json.delta?.type === "input_json_delta") {
              const id = json.index !== void 0 ? indexToKey.get(json.index) ?? `tu-${json.index}` : "tu-0";
              if (json.index !== void 0) indexToKey.set(json.index, id);
              const ex = toolUses.get(id) ?? { name: "", args: "" };
              ex.args += json.delta.partial_json;
              toolUses.set(id, ex);
            }
            break;
          case "content_block_start":
            if (json.content_block?.type === "tool_use") {
              const id = json.content_block.id;
              if (json.index !== void 0) indexToKey.set(json.index, id);
              toolUses.set(id, {
                name: json.content_block.name,
                args: ""
              });
            }
            break;
        }
      }
      if (toolUses.size) {
        const calls = Array.from(toolUses.entries()).map(([id, v]) => ({
          id,
          name: v.name,
          arguments: v.args
        }));
        cb.onToolCalls?.(calls);
      }
      cb.onDone();
    } catch (e) {
      cb.onError(e);
    }
  }
};
var GeminiProvider = class extends BaseProvider {
  chat(messages, tools, cb) {
    const model = this.config.model;
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/models/${model}:streamGenerateContent?alt=sse&key=${this.config.apiKey}`;
    const contents = [];
    let systemInstruction = "";
    for (const m of messages) {
      if (m.role === "system") {
        systemInstruction += m.content + "\n";
        continue;
      }
      if (m.role === "user") {
        contents.push({ role: "user", parts: [{ text: m.content }] });
      } else if (m.role === "assistant") {
        if (m.tool_calls && m.tool_calls.length) {
          contents.push({
            role: "model",
            parts: m.tool_calls.map((tc) => ({
              functionCall: { name: tc.name, args: safeParse(tc.arguments) }
            }))
          });
        } else {
          contents.push({ role: "model", parts: [{ text: m.content }] });
        }
      } else if (m.role === "tool") {
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: m.tool_name ?? m.tool_call_id ?? "tool",
                response: { result: m.content }
              }
            }
          ]
        });
      }
    }
    const payload = {
      contents,
      systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : void 0,
      generationConfig: {
        maxOutputTokens: this.runtime.maxTokens,
        temperature: this.runtime.temperature
      }
    };
    const geminiTools = [];
    if (tools.length) {
      geminiTools.push({
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }))
      });
    }
    if (this.config.supportsWebSearch) {
      geminiTools.push({ googleSearch: {} });
    }
    if (geminiTools.length) payload.tools = geminiTools;
    return this.runStream(url, this.getHeaders(), payload, cb);
  }
  async runStream(url, headers, payload, cb) {
    try {
      const toolCalls = /* @__PURE__ */ new Map();
      for await (const data of this.streamLines(JSON.stringify(payload), url, headers)) {
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        const parts = json.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part.text) cb.onToken(part.text);
          if (part.functionCall) {
            const id = `fc-${part.functionCall.name}`;
            toolCalls.set(id, {
              name: part.functionCall.name,
              args: JSON.stringify(part.functionCall.args ?? {})
            });
          }
        }
      }
      if (toolCalls.size) {
        const calls = Array.from(toolCalls.entries()).map(([id, v]) => ({
          id,
          name: v.name,
          arguments: v.args
        }));
        cb.onToolCalls?.(calls);
      }
      cb.onDone();
    } catch (e) {
      cb.onError(e);
    }
  }
};
function createProvider(config, runtime = {}) {
  switch (config.type) {
    case "openai":
    case "openai-compatible":
    case "custom":
      return new OpenAIProvider(config, runtime);
    case "anthropic":
      return new AnthropicProvider(config, runtime);
    case "gemini":
      return new GeminiProvider(config, runtime);
    default:
      return new OpenAIProvider(config, runtime);
  }
}
async function probeModels(config) {
  try {
    let url = "";
    let headers = { "Content-Type": "application/json" };
    if (config.type === "gemini") {
      url = `${config.baseUrl.replace(/\/$/, "")}/models?key=${config.apiKey}`;
    } else if (config.type === "anthropic") {
      if (!config.apiKey) return { ok: false, models: [], error: "API key required" };
      return { ok: true, models: [config.model] };
    } else {
      url = `${config.baseUrl.replace(/\/$/, "")}/models`;
      headers = { ...headers, Authorization: `Bearer ${config.apiKey}` };
    }
    if (config.extraHeaders) {
      try {
        Object.assign(headers, JSON.parse(config.extraHeaders));
      } catch {
      }
    }
    let resp;
    if (config.type === "gemini") {
      resp = await (0, import_obsidian.requestUrl)({ url, method: "GET" });
    } else {
      resp = await (0, import_obsidian.requestUrl)({ url, method: "GET", headers });
    }
    if (resp.status >= 400) {
      return {
        ok: false,
        models: [],
        error: `HTTP ${resp.status}: ${(resp.text || "").slice(0, 300)}`
      };
    }
    const json = typeof resp.json === "function" ? resp.json() : JSON.parse(resp.text || "{}");
    let models = [];
    if (config.type === "gemini") {
      models = (json.models ?? []).map((m) => (m.name || "").replace(/^models\//, "")).filter(Boolean);
    } else {
      models = (json.data ?? []).map((m) => m.id ?? m.name).filter(Boolean);
    }
    return { ok: true, models };
  } catch (e) {
    return { ok: false, models: [], error: e?.message ?? String(e) };
  }
}
function safeParse(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

// src/settings.ts
var DEFAULT_SETTINGS = {
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
      supportsVision: true
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
      supportsVision: true
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
      supportsVision: true
    },
    {
      id: "openai-compatible-default",
      name: "OpenAI-Compatible (DeepSeek/Qwen/OpenRouter\u2026)",
      type: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "deepseek-chat",
      extraHeaders: "",
      supportsWebSearch: false,
      supportsVision: false
    }
  ],
  activeProviderId: "openai-default",
  maxTokens: 4096,
  temperature: 0.7,
  systemPrompt: 'You are Agenter, a helpful AI assistant embedded in Obsidian.\n\nYou have tools to read sections and metadata, inspect links/tags/folders, write and safely edit notes, move notes to recoverable Trash, search the vault and web, fetch public URLs, inspect plugins, and analyze note images. All file tools are strictly limited to the Obsidian vault. Use tools whenever the request requires workspace data.\n\n## Tool guidance\n- To refer to "this note" / "the current note", call `current_note`.\n- Prefer `append_note` when the user wants to add content to the end of a note, `edit_note` for a targeted change, and `write_note` only to create a new note or when a full overwrite is explicitly requested.\n- Before writing, briefly tell the user what you are about to do in one short sentence (e.g. "I\'ll append these three bullet points to Daily/2026-07-16.md").\n- All mutations should be deliberate. Never claim a change happened before its tool succeeds. `trash_note` is recoverable, always requires confirmation, and must never be used unless the user clearly asked to remove that exact note.\n- Prefer `read_note_section`, `note_metadata`, and `note_links` over reading a whole long note when sufficient.\n- File paths must be relative to the vault. Never attempt filesystem, shell, or paths outside the vault.\n- When you edit notes, preserve existing content unless asked to change it.\n\n## Style\n- Answer in the user\'s language. Be concise. Use markdown: headings, **bold**, lists, and fenced code blocks with a language tag.',
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
    extract: "Extract tasks, dates, names, decisions, and open questions from the selected text."
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
    trash_note: true
  }
};
function getActiveProvider(settings) {
  return settings.providers.find((p) => p.id === settings.activeProviderId);
}
function genId(prefix = "s") {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}
function deriveTitle(messages) {
  const firstUser = messages.find((m) => m.role === "user");
  const raw = (firstUser?.content ?? "").trim().replace(/\s+/g, " ");
  if (!raw) return "New chat";
  return raw.length > 42 ? raw.slice(0, 42) + "\u2026" : raw;
}
function getActiveSession(settings) {
  let session = settings.sessions.find((s) => s.id === settings.activeSessionId);
  if (!session) {
    session = {
      id: genId(),
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    settings.sessions.unshift(session);
    settings.activeSessionId = session.id;
  }
  return session;
}
var AgentSettingTab = class extends import_obsidian2.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian2.Setting(containerEl).setName("Providers").setHeading();
    new import_obsidian2.Setting(containerEl).setName("Active provider").setDesc("Select which provider/model to use for chat.").addDropdown((dd) => {
      this.plugin.settings.providers.forEach((p) => {
        dd.addOption(p.id, `${p.name} \u2014 ${p.model}`);
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
        marginBottom: "12px"
      });
      new import_obsidian2.Setting(wrapper).setName(`Provider: ${provider.name}`).setDesc(`Type: ${provider.type}`).addButton(
        (btn) => btn.setButtonText("Remove").onClick(async () => {
          this.plugin.settings.providers = this.plugin.settings.providers.filter(
            (p) => p.id !== provider.id
          );
          if (this.plugin.settings.activeProviderId === provider.id) {
            this.plugin.settings.activeProviderId = this.plugin.settings.providers[0]?.id ?? "";
          }
          await this.plugin.saveSettings();
          this.display();
        })
      ).addButton(
        (btn) => btn.setButtonText("Test").onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("Testing\u2026");
          const res = await probeModels(provider);
          btn.setDisabled(false);
          btn.setButtonText("Test");
          if (!res.ok) {
            new import_obsidian2.Notice(`\u274C ${provider.name}: ${res.error ?? "failed"}`);
            return;
          }
          const found = res.models.includes(provider.model);
          if (found) {
            new import_obsidian2.Notice(`\u2705 ${provider.name}: connected, model "${provider.model}" OK`);
          } else if (res.models.length) {
            new import_obsidian2.Notice(
              `\u26A0\uFE0F ${provider.name}: connected, but "${provider.model}" not in list (${res.models.length} models available)`
            );
          } else {
            new import_obsidian2.Notice(`\u2705 ${provider.name}: connected`);
          }
        })
      );
      new import_obsidian2.Setting(wrapper).setName("Display name").addText(
        (t) => t.setValue(provider.name).onChange(async (v) => {
          provider.name = v;
          await this.plugin.saveSettings();
        })
      );
      new import_obsidian2.Setting(wrapper).setName("Type").addDropdown((dd) => {
        dd.addOption("openai", "OpenAI");
        dd.addOption("openai-compatible", "OpenAI-Compatible");
        dd.addOption("anthropic", "Anthropic");
        dd.addOption("gemini", "Gemini");
        dd.addOption("custom", "Custom");
        dd.setValue(provider.type);
        dd.onChange(async (v) => {
          provider.type = v;
          await this.plugin.saveSettings();
          this.display();
        });
      });
      new import_obsidian2.Setting(wrapper).setName("Base URL").addText(
        (t) => t.setValue(provider.baseUrl).onChange(async (v) => {
          provider.baseUrl = v;
          await this.plugin.saveSettings();
        })
      );
      new import_obsidian2.Setting(wrapper).setName("API key").addText((t) => {
        t.inputEl.type = "password";
        t.setValue(provider.apiKey).onChange(async (v) => {
          provider.apiKey = v;
          await this.plugin.saveSettings();
        });
      });
      let modelDD;
      const modelSetting = new import_obsidian2.Setting(wrapper).setName("Model");
      modelSetting.addDropdown((dd) => {
        modelDD = dd;
        dd.addOption(provider.model, provider.model);
        dd.setValue(provider.model);
        dd.onChange(async (v) => {
          provider.model = v;
          await this.plugin.saveSettings();
        });
      });
      modelSetting.addButton(
        (btn) => btn.setButtonText("Fetch models").onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("Fetching\u2026");
          const res = await probeModels(provider);
          btn.setDisabled(false);
          btn.setButtonText("Fetch models");
          if (!res.ok) {
            new import_obsidian2.Notice(`\u274C ${provider.name}: ${res.error ?? "failed"}`);
            return;
          }
          if (!res.models.length) {
            new import_obsidian2.Notice(`\u2705 ${provider.name}: connected (no model list)`);
            return;
          }
          modelDD.selectEl.empty();
          for (const m of res.models) modelDD.addOption(m, m);
          if (res.models.includes(provider.model)) modelDD.setValue(provider.model);
          else modelDD.setValue(res.models[0]);
          new import_obsidian2.Notice(`\u2705 ${provider.name}: ${res.models.length} models loaded`);
        })
      );
      new import_obsidian2.Setting(wrapper).setName("Extra headers (JSON)").setDesc('Only for custom providers. e.g. {"Authorization":"Bearer x"}').addTextArea((t) => {
        t.setValue(provider.extraHeaders);
        t.inputEl.rows = 2;
        t.onChange(async (v) => {
          provider.extraHeaders = v;
          await this.plugin.saveSettings();
        });
      });
      new import_obsidian2.Setting(wrapper).setName("Supports web search").addToggle(
        (tg) => tg.setValue(provider.supportsWebSearch).onChange(async (v) => {
          provider.supportsWebSearch = v;
          await this.plugin.saveSettings();
        })
      );
      new import_obsidian2.Setting(wrapper).setName("Supports vision").addToggle(
        (tg) => tg.setValue(provider.supportsVision).onChange(async (v) => {
          provider.supportsVision = v;
          await this.plugin.saveSettings();
        })
      );
    });
    new import_obsidian2.Setting(containerEl).setName("Add new provider").addButton(
      (btn) => btn.setButtonText("+ Add provider").onClick(() => {
        new ProviderModal(this.app, this.plugin, (provider) => {
          this.plugin.settings.providers.push(provider);
          void this.plugin.saveSettings();
          this.display();
        }).open();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Chat behavior").setHeading();
    new import_obsidian2.Setting(containerEl).setName("Default context scope").setDesc("What notes to include in context by default.").addDropdown((dd) => {
      dd.addOption("note", "Current note");
      dd.addOption("folder", "Current folder");
      dd.addOption("vault", "Whole vault");
      dd.addOption("none", "None");
      dd.setValue(this.plugin.settings.defaultContextScope);
      dd.onChange(async (v) => {
        this.plugin.settings.defaultContextScope = v;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian2.Setting(containerEl).setName("Max context notes").setDesc("0 = include all notes in folder/vault scope.").addText(
      (t) => t.setValue(String(this.plugin.settings.maxContextNotes)).onChange(async (v) => {
        const n = parseInt(v, 10);
        this.plugin.settings.maxContextNotes = isNaN(n) ? 0 : n;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Max tokens").addText(
      (t) => t.setValue(String(this.plugin.settings.maxTokens)).onChange(async (v) => {
        const n = parseInt(v, 10);
        this.plugin.settings.maxTokens = isNaN(n) ? 4096 : n;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Temperature").addSlider(
      (s) => s.setLimits(0, 2, 0.1).setValue(this.plugin.settings.temperature).onChange(async (v) => {
        this.plugin.settings.temperature = v;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Streaming").addToggle(
      (tg) => tg.setValue(this.plugin.settings.streaming).onChange(async (v) => {
        this.plugin.settings.streaming = v;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("System prompt").addTextArea((t) => {
      t.setValue(this.plugin.settings.systemPrompt);
      t.inputEl.rows = 4;
      t.onChange(async (v) => {
        this.plugin.settings.systemPrompt = v;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian2.Setting(containerEl).setName("Custom prompts").setHeading();
    containerEl.createEl("p", {
      text: "Build your own reusable prompts (like Summarize or Rewrite). They appear in the chat / menu and beside selected text. Use {{selection}} where the selected text should go; if omitted, the selection is appended automatically.",
      cls: "setting-item-description"
    });
    this.renderPromptBuilder(containerEl.createDiv({ cls: "agenter-prompt-builder" }));
    new import_obsidian2.Setting(containerEl).setName("Tool approval").setHeading();
    containerEl.createEl("p", {
      text: "Mutating tools pause and show a preview before they run. Moving a note to Trash always requires a two-step confirmation and cannot be disabled. Every note mutation also creates a recoverable safety backup inside the vault.",
      cls: "setting-item-description"
    });
    const APPROVABLE = [
      { key: "write_note", label: "Create / overwrite a note" },
      { key: "edit_note", label: "Edit a note (find & replace)" },
      { key: "append_note", label: "Append to a note" },
      { key: "create_folder", label: "Create a vault folder" },
      { key: "move_note", label: "Move / rename a note" },
      { key: "trash_note", label: "Move a note to recoverable Trash (always confirmed)" }
    ];
    for (const t of APPROVABLE) {
      new import_obsidian2.Setting(containerEl).setName(t.label).setDesc(`Tool: ${t.key}`).addToggle(
        (tg) => tg.setValue(this.plugin.settings.toolApproval?.[t.key] ?? true).onChange(async (v) => {
          if (!this.plugin.settings.toolApproval) this.plugin.settings.toolApproval = {};
          this.plugin.settings.toolApproval[t.key] = v;
          await this.plugin.saveSettings();
        })
      );
    }
  }
  renderPromptBuilder(host) {
    host.empty();
    const prompts = this.plugin.settings.customPrompts ?? {};
    const keys = Object.keys(prompts);
    if (!keys.length) {
      host.createEl("p", {
        text: "No custom prompts yet. Add your first one below.",
        cls: "setting-item-description"
      });
    }
    for (const key of keys) {
      const card = host.createDiv({ cls: "agenter-prompt-card" });
      const nameSetting = new import_obsidian2.Setting(card).setName(key);
      nameSetting.addExtraButton(
        (b) => b.setIcon("pencil").setTooltip("Rename").onClick(() => this.promptEditModal(key, prompts[key], host))
      );
      nameSetting.addExtraButton(
        (b) => b.setIcon("trash").setTooltip("Delete").onClick(async () => {
          delete this.plugin.settings.customPrompts[key];
          await this.plugin.saveSettings();
          this.renderPromptBuilder(host);
        })
      );
      const body = new import_obsidian2.Setting(card).setClass("agenter-prompt-card-body");
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
    new import_obsidian2.Setting(host).addButton(
      (b) => b.setButtonText("+ Add custom prompt").setCta().onClick(() => this.promptEditModal("", "", host))
    );
  }
  promptEditModal(originalKey, value, host) {
    const modal = new import_obsidian2.Modal(this.app);
    modal.titleEl.setText(originalKey ? "Edit prompt" : "New prompt");
    const { contentEl } = modal;
    let name = originalKey;
    let text = value;
    new import_obsidian2.Setting(contentEl).setName("Name").setDesc("Short label, e.g. Translate to English").addText(
      (t) => t.setPlaceholder("My prompt").setValue(name).onChange((v) => name = v)
    );
    new import_obsidian2.Setting(contentEl).setName("Prompt").setDesc("Use {{selection}} to place selected text. Otherwise it is appended.").addTextArea((t) => {
      t.setPlaceholder("Summarize the following text in 3 bullet points:\n\n{{selection}}");
      t.setValue(text);
      t.inputEl.rows = 6;
      t.inputEl.addClass("agenter-prompt-textarea");
      t.onChange((v) => text = v);
    });
    new import_obsidian2.Setting(contentEl).addButton(
      (b) => b.setButtonText("Save").setCta().onClick(async () => {
        const cleanName = name.trim();
        if (!cleanName) {
          new import_obsidian2.Notice("Please enter a name for the prompt.");
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
};
var ProviderModal = class extends import_obsidian2.Modal {
  constructor(app, plugin, onSubmit) {
    super(app);
    this.plugin = plugin;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    new import_obsidian2.Setting(contentEl).setName("Add provider").setHeading();
    const vals = {
      id: "tmp",
      name: "New Provider",
      type: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o",
      extraHeaders: "",
      supportsWebSearch: false,
      supportsVision: false
    };
    new import_obsidian2.Setting(contentEl).setName("Name").addText(
      (t) => t.setValue(vals.name).onChange((v) => vals.name = v)
    );
    new import_obsidian2.Setting(contentEl).setName("Type").addDropdown((dd) => {
      dd.addOption("openai", "OpenAI");
      dd.addOption("openai-compatible", "OpenAI-Compatible");
      dd.addOption("anthropic", "Anthropic");
      dd.addOption("gemini", "Gemini");
      dd.addOption("custom", "Custom");
      dd.setValue(vals.type);
      dd.onChange((v) => vals.type = v);
    });
    new import_obsidian2.Setting(contentEl).setName("Base URL").addText(
      (t) => t.setValue(vals.baseUrl).onChange((v) => vals.baseUrl = v)
    );
    new import_obsidian2.Setting(contentEl).setName("API key").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => vals.apiKey = v);
    });
    new import_obsidian2.Setting(contentEl).setName("Model").addDropdown((dd) => {
      dd.addOption(vals.model, vals.model);
      dd.setValue(vals.model);
      dd.onChange((v) => vals.model = v);
      contentEl._modelDD = dd;
    }).addButton(
      (btn) => btn.setButtonText("Fetch models").onClick(async () => {
        btn.setDisabled(true);
        btn.setButtonText("Fetching\u2026");
        const res = await probeModels(vals);
        btn.setDisabled(false);
        btn.setButtonText("Fetch models");
        if (!res.ok) {
          status.setText(`\u274C ${res.error ?? "Connection failed"}`);
          return;
        }
        if (!res.models.length) {
          status.setText(`\u2705 Connected (no model list)`);
          return;
        }
        const dd = contentEl._modelDD;
        dd.selectEl.empty();
        for (const m of res.models) dd.addOption(m, m);
        if (res.models.includes(vals.model)) dd.setValue(vals.model);
        else dd.setValue(res.models[0]);
        vals.model = res.models.includes(vals.model) ? vals.model : res.models[0];
        status.setText(`\u2705 ${res.models.length} models loaded. Pick one above.`);
      })
    );
    const status = contentEl.createEl("p");
    status.setCssStyles({ fontSize: "12px", opacity: "0.8" });
    new import_obsidian2.Setting(contentEl).addButton(
      (btn) => btn.setButtonText("Test connection & fetch models").onClick(async () => {
        btn.setDisabled(true);
        status.setText("Testing\u2026");
        const res = await probeModels(vals);
        if (!res.ok) {
          status.setText(`\u274C ${res.error ?? "Connection failed"}`);
          btn.setDisabled(false);
          return;
        }
        const found = res.models.includes(vals.model);
        if (found) {
          status.setText(`\u2705 Connected. Model "${vals.model}" is available.`);
        } else if (res.models.length) {
          status.setText(
            `\u26A0\uFE0F Connected, but model "${vals.model}" not in list. Available: ${res.models.slice(0, 8).join(", ")}${res.models.length > 8 ? "\u2026" : ""}`
          );
        } else {
          status.setText(`\u2705 Connected (no model list returned).`);
        }
        btn.setDisabled(false);
      })
    );
    new import_obsidian2.Setting(contentEl).addButton(
      (btn) => btn.setButtonText("Add").setCta().onClick(() => {
        const id = "custom-" + Date.now().toString(36);
        this.onSubmit({
          ...vals,
          id,
          extraHeaders: vals.extraHeaders || ""
        });
        this.close();
      })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
};

// src/ui.ts
var import_obsidian4 = require("obsidian");

// src/tools.ts
var import_obsidian3 = require("obsidian");
var ToolRegistry = class {
  constructor(app) {
    this.app = app;
  }
  getDefinitions() {
    return [
      {
        name: "read_note",
        description: "Read the full content of a note by its path (relative to vault root, e.g. 'Folder/Note.md'). Returns markdown content.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path inside the vault" }
          },
          required: ["path"]
        }
      },
      {
        name: "write_note",
        description: "Create a new note or fully overwrite an existing note with the given markdown content. Use with care \u2014 overwrites existing content.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path to create/overwrite" },
            content: { type: "string", description: "Markdown content" }
          },
          required: ["path", "content"]
        }
      },
      {
        name: "edit_note",
        description: "Edit an existing note by replacing an exact old string with a new string. Returns a confirmation or an error if the old string is not found (or not unique).",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path" },
            old_string: { type: "string", description: "Exact text to replace" },
            new_string: { type: "string", description: "Replacement text" }
          },
          required: ["path", "old_string", "new_string"]
        }
      },
      {
        name: "append_note",
        description: "Append markdown content to the end of an existing note.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path" },
            content: { type: "string", description: "Content to append" }
          },
          required: ["path", "content"]
        }
      },
      {
        name: "search_notes",
        description: "Full-text search across the vault. Returns a list of matching notes with a short snippet.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            limit: { type: "number", description: "Max results (default 10)" }
          },
          required: ["query"]
        }
      },
      {
        name: "list_notes",
        description: "List notes in a folder (or the whole vault). Returns paths. Use scope='vault' for everything.",
        parameters: {
          type: "object",
          properties: {
            folder: {
              type: "string",
              description: "Folder path, or empty string / 'vault' for the whole vault"
            },
            limit: { type: "number", description: "Max results (default 50)" }
          },
          required: []
        }
      },
      {
        name: "summarize_note",
        description: "Return a concise summary of a note's content (first portion if very long).",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path" }
          },
          required: ["path"]
        }
      },
      {
        name: "get_note_images",
        description: "Return embedded and linked image files in a note as base64 data URIs so the model can see them (vision). Returns a list of {name, mime, dataUri}.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path" }
          },
          required: ["path"]
        }
      },
      {
        name: "web_search",
        description: "Search the web for current information. Returns concise search-result titles, URLs, and snippets when available. Provide a precise query.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Web search query" }
          },
          required: ["query"]
        }
      },
      {
        name: "current_note",
        description: "Get the path and content of the note currently open in the active editor. Use this to refer to 'this note'.",
        parameters: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: "list_plugins",
        description: "List installed Obsidian plugins and whether each plugin is enabled. Use when the user asks what plugins are installed or wants plugin-aware help.",
        parameters: {
          type: "object",
          properties: {
            includeDisabled: {
              type: "boolean",
              description: "Include disabled plugins too (default true)."
            }
          },
          required: []
        }
      },
      {
        name: "plugin_info",
        description: "Get detailed manifest information for an installed Obsidian plugin by id or name.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Plugin id or display name" }
          },
          required: ["query"]
        }
      },
      {
        name: "fetch_url",
        description: "Fetch a public URL and return readable text (truncated). Use for web pages or raw text files when the user provides a URL.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "HTTP/HTTPS URL to fetch" }
          },
          required: ["url"]
        }
      },
      {
        name: "find_images",
        description: "Find image files in the vault by folder/name. Returns paths and sizes so the assistant can decide which image to inspect with get_note_images or read as context.",
        parameters: {
          type: "object",
          properties: {
            folder: { type: "string", description: "Folder path, or empty/vault for all vault images" },
            query: { type: "string", description: "Optional filename/path substring filter" },
            limit: { type: "number", description: "Max results (default 30)" }
          },
          required: []
        }
      },
      {
        name: "read_note_section",
        description: "Read one heading section from a markdown note. More efficient than reading the whole note.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note path inside the vault" },
            heading: { type: "string", description: "Heading text, without # characters" }
          },
          required: ["path", "heading"]
        }
      },
      {
        name: "note_metadata",
        description: "Get safe metadata for a note: path, size, created/modified times, frontmatter, headings, and tags.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Note path inside the vault" } },
          required: ["path"]
        }
      },
      {
        name: "note_links",
        description: "Get outgoing links, embeds, and backlinks for a note using Obsidian's metadata cache.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Note path inside the vault" } },
          required: ["path"]
        }
      },
      {
        name: "list_folders",
        description: "List folders inside the vault, optionally below one folder.",
        parameters: {
          type: "object",
          properties: {
            folder: { type: "string", description: "Folder path, or empty/vault for the whole vault" },
            limit: { type: "number", description: "Max results (default 100)" }
          },
          required: []
        }
      },
      {
        name: "create_folder",
        description: "Create a folder inside the Obsidian vault. Requires user approval.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Folder path inside the vault" } },
          required: ["path"]
        }
      },
      {
        name: "move_note",
        description: "Move or rename a markdown note inside the vault. Creates a safety backup and requires user approval.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Current note path" },
            destination: { type: "string", description: "New path inside the vault" }
          },
          required: ["path", "destination"]
        }
      },
      {
        name: "trash_note",
        description: "Move a markdown note to Obsidian Trash (never permanently delete it). Always creates a safety backup and requires a two-step user confirmation.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Note path inside the vault" } },
          required: ["path"]
        }
      }
    ];
  }
  async execute(call) {
    try {
      const args = JSON.parse(call.arguments || "{}");
      const out = await this.dispatch(call.name, args);
      return { callId: call.id, output: out };
    } catch (e) {
      return { callId: call.id, output: `Tool error: ${e.message ?? String(e)}` };
    }
  }
  async dispatch(name, args) {
    switch (name) {
      case "read_note":
        return this.readNote(args.path);
      case "write_note":
        return this.writeNote(args.path, args.content);
      case "edit_note":
        return this.editNote(args.path, args.old_string, args.new_string);
      case "append_note":
        return this.appendNote(args.path, args.content);
      case "search_notes":
        return this.searchNotes(args.query, args.limit ?? 10);
      case "list_notes":
        return this.listNotes(args.folder, args.limit ?? 50);
      case "summarize_note":
        return this.summarizeNote(args.path);
      case "get_note_images":
        return this.getNoteImages(args.path);
      case "web_search":
        return this.webSearch(args.query);
      case "current_note":
        return this.currentNote();
      case "list_plugins":
        return this.listPlugins(args.includeDisabled ?? true);
      case "plugin_info":
        return this.pluginInfo(args.query);
      case "fetch_url":
        return this.fetchUrl(args.url);
      case "find_images":
        return this.findImages(args.folder, args.query, args.limit ?? 30);
      case "read_note_section":
        return this.readNoteSection(args.path, args.heading);
      case "note_metadata":
        return this.noteMetadata(args.path);
      case "note_links":
        return this.noteLinks(args.path);
      case "list_folders":
        return this.listFolders(args.folder, args.limit ?? 100);
      case "create_folder":
        return this.createFolder(args.path);
      case "move_note":
        return this.moveNote(args.path, args.destination);
      case "trash_note":
        return this.trashNote(args.path);
      default:
        return `Unknown tool: ${name}`;
    }
  }
  async readNote(path) {
    const p = safeVaultPath(path);
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!file || !(file instanceof import_obsidian3.TFile) || file.extension !== "md") return `Note not found: ${p}`;
    return await this.app.vault.read(file);
  }
  async writeNote(path, content) {
    const p = safeVaultPath(path, true);
    const existing = this.app.vault.getAbstractFileByPath(p);
    if (existing instanceof import_obsidian3.TFile) {
      const backup = await createSafetyBackup(this.app, existing, "overwrite");
      await this.app.vault.modify(existing, String(content ?? ""));
      return `Overwrote ${p}
Safety backup: ${backup}`;
    }
    await ensureParentFolder(this.app, p);
    await this.app.vault.create(p, String(content ?? ""));
    return `Created ${p}`;
  }
  async editNote(path, oldS, newS) {
    const p = safeVaultPath(path, true);
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!file || !(file instanceof import_obsidian3.TFile)) return `Note not found: ${p}`;
    const content = await this.app.vault.read(file);
    if (!String(oldS ?? "")) return "old_string cannot be empty.";
    const count = content.split(oldS).length - 1;
    if (count === 0) return `old_string not found in ${p}`;
    if (count > 1) return `old_string is not unique in ${p} (found ${count} matches)`;
    const backup = await createSafetyBackup(this.app, file, "edit");
    await this.app.vault.modify(file, content.replace(oldS, String(newS ?? "")));
    return `Edited ${p}
Safety backup: ${backup}`;
  }
  async appendNote(path, content) {
    const p = safeVaultPath(path, true);
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!file || !(file instanceof import_obsidian3.TFile)) return `Note not found: ${p}`;
    const existing = await this.app.vault.read(file);
    const backup = await createSafetyBackup(this.app, file, "append");
    await this.app.vault.modify(file, existing + "\n" + String(content ?? ""));
    return `Appended to ${p}
Safety backup: ${backup}`;
  }
  async searchNotes(query, limit) {
    const files = this.app.vault.getMarkdownFiles();
    const q = query.toLowerCase();
    const results = [];
    for (const f of files) {
      const content = await this.app.vault.cachedRead(f);
      if (content.toLowerCase().includes(q)) {
        const idx = content.toLowerCase().indexOf(q);
        const snippet = content.slice(Math.max(0, idx - 60), idx + 120).replace(/\n/g, " ");
        results.push(`- ${f.path}: \u2026${snippet}\u2026`);
        if (results.length >= limit) break;
      }
    }
    return results.length ? results.join("\n") : "No matching notes found.";
  }
  async listNotes(folder, limit) {
    const root = this.app.vault.getRoot();
    let base = root;
    if (folder && folder !== "vault") {
      const f = this.app.vault.getAbstractFileByPath(safeVaultPath(folder));
      if (f instanceof import_obsidian3.TFolder) base = f;
      else return `Folder not found: ${folder}`;
    }
    const out = [];
    VaultWalker(base, (file) => {
      if (file instanceof import_obsidian3.TFile && out.length < limit) out.push(file.path);
    });
    return out.length ? out.join("\n") : "No notes found.";
  }
  async summarizeNote(path) {
    const content = await this.readNote(path);
    const head = content.length > 4e3 ? content.slice(0, 4e3) + "\n\u2026(truncated)" : content;
    return `Content of ${path} (${content.length} chars):

${head}`;
  }
  async getNoteImages(path) {
    const file = this.app.vault.getAbstractFileByPath(safeVaultPath(path));
    if (!file || !(file instanceof import_obsidian3.TFile)) return `Note not found: ${path}`;
    const content = await this.app.vault.read(file);
    const emb = [];
    let embMatch;
    const embRe = /!\[\[([^\]]+\.(png|jpg|jpeg|gif|webp|bmp))\]\]/gi;
    while ((embMatch = embRe.exec(content)) !== null) emb.push(embMatch[1]);
    const md = [];
    let mdMatch;
    const mdRe = /!\[[^\]]*\]\(([^)]+\.(png|jpg|jpeg|gif|webp|bmp))\)/gi;
    while ((mdMatch = mdRe.exec(content)) !== null) md.push(mdMatch[1]);
    const names = Array.from(/* @__PURE__ */ new Set([...emb, ...md]));
    const out = [];
    for (const name of names) {
      const imgPath = safeVaultPath(resolveSibling(file, name));
      const imgFile = this.app.vault.getAbstractFileByPath(imgPath);
      if (imgFile instanceof import_obsidian3.TFile) {
        const buf = await this.app.vault.readBinary(imgFile);
        const mime = mimeFromName(name);
        const b64 = arrayBufferToBase64(buf);
        out.push(
          JSON.stringify({ name, mime, dataUri: `data:${mime};base64,${b64}` })
        );
      }
    }
    return out.length ? out.join("\n") : "No images found in this note.";
  }
  async currentNote() {
    const active = this.app.workspace.getActiveFile();
    if (!active) return "No note currently open.";
    const content = await this.app.vault.read(active);
    return `Current note path: ${active.path}

${content}`;
  }
  async readNoteSection(path, heading) {
    const p = safeVaultPath(path, true);
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!(file instanceof import_obsidian3.TFile)) return `Note not found: ${p}`;
    const content = await this.app.vault.read(file);
    const wanted = String(heading ?? "").replace(/^#+\s*/, "").trim().toLowerCase();
    if (!wanted) return "Heading is required.";
    const lines = content.split("\n");
    let start = -1;
    let level = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
      if (m && m[2].replace(/\s+#+$/, "").trim().toLowerCase() === wanted) {
        start = i;
        level = m[1].length;
        break;
      }
    }
    if (start < 0) return `Heading not found in ${p}: ${heading}`;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const m = /^(#{1,6})\s+/.exec(lines[i]);
      if (m && m[1].length <= level) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end).join("\n");
  }
  noteMetadata(path) {
    const p = safeVaultPath(path, true);
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!(file instanceof import_obsidian3.TFile)) return `Note not found: ${p}`;
    const cache = this.app.metadataCache.getFileCache(file) ?? {};
    const tags = Array.from(/* @__PURE__ */ new Set([
      ...(cache.tags ?? []).map((t) => t.tag),
      ...frontmatterTags(cache.frontmatter?.tags)
    ]));
    return JSON.stringify({
      path: file.path,
      basename: file.basename,
      size: file.stat.size,
      created: new Date(file.stat.ctime).toISOString(),
      modified: new Date(file.stat.mtime).toISOString(),
      frontmatter: cache.frontmatter ?? {},
      headings: (cache.headings ?? []).map((h) => ({ heading: h.heading, level: h.level })),
      tags
    }, null, 2);
  }
  noteLinks(path) {
    const p = safeVaultPath(path, true);
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!(file instanceof import_obsidian3.TFile)) return `Note not found: ${p}`;
    const cache = this.app.metadataCache.getFileCache(file) ?? {};
    const outgoing = (cache.links ?? []).map((l) => l.link);
    const embeds = (cache.embeds ?? []).map((l) => l.link);
    const backlinks = [];
    const resolved = this.app.metadataCache.resolvedLinks ?? {};
    for (const source of Object.keys(resolved)) {
      if (resolved[source]?.[file.path]) backlinks.push(source);
    }
    return JSON.stringify({ path: file.path, outgoing, embeds, backlinks }, null, 2);
  }
  listFolders(folder, limit) {
    let base = this.app.vault.getRoot();
    if (folder && folder !== "vault") {
      const p = safeVaultPath(folder);
      const found = this.app.vault.getAbstractFileByPath(p);
      if (!(found instanceof import_obsidian3.TFolder)) return `Folder not found: ${p}`;
      base = found;
    }
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (out.length >= clampLimit(limit, 500)) return;
        if (child instanceof import_obsidian3.TFolder) {
          out.push(child.path);
          walk(child);
        }
      }
    };
    walk(base);
    return out.length ? out.join("\n") : "No folders found.";
  }
  async createFolder(path) {
    const p = safeVaultPath(path);
    if (this.app.vault.getAbstractFileByPath(p)) return `Path already exists: ${p}`;
    await ensureFolder(this.app, p);
    return `Created folder ${p}`;
  }
  async moveNote(path, destination) {
    const from = safeVaultPath(path, true);
    const to = safeVaultPath(destination, true);
    const file = this.app.vault.getAbstractFileByPath(from);
    if (!(file instanceof import_obsidian3.TFile)) return `Note not found: ${from}`;
    if (this.app.vault.getAbstractFileByPath(to)) return `Destination already exists: ${to}`;
    const backup = await createSafetyBackup(this.app, file, "move");
    await ensureParentFolder(this.app, to);
    await this.app.fileManager.renameFile(file, to);
    return `Moved ${from} to ${to}
Safety backup: ${backup}`;
  }
  async trashNote(path) {
    const p = safeVaultPath(path, true);
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!(file instanceof import_obsidian3.TFile)) return `Note not found: ${p}`;
    const backup = await createSafetyBackup(this.app, file, "trash");
    await this.app.fileManager.trashFile(file);
    return `Moved ${p} to Obsidian Trash (recoverable).
Safety backup: ${backup}`;
  }
  async webSearch(query) {
    const q = String(query ?? "").trim();
    if (!q) return "Search query is required.";
    const lines = [];
    try {
      const url = "https://api.duckduckgo.com/?q=" + encodeURIComponent(q) + "&format=json&no_html=1&skip_disambig=1";
      const resp = await (0, import_obsidian3.requestUrl)({ url, method: "GET" });
      if (resp.status < 400) {
        const json = typeof resp.json === "function" ? resp.json() : JSON.parse(resp.text || "{}");
        if (json.AbstractText) {
          lines.push(`Answer: ${json.AbstractText}`);
          if (json.AbstractURL) lines.push(`Source: ${json.AbstractURL}`);
        }
        if (json.Answer && typeof json.Answer === "string") {
          lines.push(`Answer: ${json.Answer}`);
        }
        if (json.Definition) {
          lines.push(`Definition: ${json.Definition}`);
          if (json.DefinitionURL) lines.push(`Source: ${json.DefinitionURL}`);
        }
        const topics = flattenDuckTopics(json.RelatedTopics ?? []).slice(0, 8);
        for (const t of topics) {
          const text = (t.Text ?? "").trim();
          const firstUrl = t.FirstURL ?? "";
          if (text) lines.push(`- ${text}${firstUrl ? `
  ${firstUrl}` : ""}`);
        }
      }
    } catch {
    }
    if (lines.length < 2) {
      try {
        const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q);
        const resp = await (0, import_obsidian3.requestUrl)({
          url,
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; ObsidianAgenter/1.0; +https://obsidian.md)"
          }
        });
        if (resp.status < 400) {
          const results = parseDuckHtml(String(resp.text ?? "")).slice(0, 8);
          for (const r of results) {
            lines.push(`- ${r.title}
  ${r.url}${r.snippet ? `
  ${r.snippet}` : ""}`);
          }
        }
      } catch {
      }
    }
    return lines.length ? lines.join("\n") : "No web results found. Try a more specific query or ask the provider to use its native web search if available.";
  }
  async fetchUrl(url) {
    if (!/^https?:\/\//i.test(url ?? "")) return "Only http/https URLs are supported.";
    try {
      const resp = await (0, import_obsidian3.requestUrl)({ url, method: "GET" });
      if (resp.status >= 400) return `Fetch failed: HTTP ${resp.status}`;
      const raw = String(resp.text ?? "");
      const text = raw.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
      return truncateText(text || raw, 6e3);
    } catch (e) {
      return `Fetch failed: ${e?.message ?? String(e)}`;
    }
  }
  listPlugins(includeDisabled) {
    const plugins = this.app.plugins;
    const manifests = plugins?.manifests ?? {};
    const enabled = new Set(Object.keys(plugins?.plugins ?? {}));
    const ids = Object.keys(manifests).sort((a, b) => {
      const an = manifests[a]?.name ?? a;
      const bn = manifests[b]?.name ?? b;
      return an.localeCompare(bn);
    });
    const lines = ids.filter((id) => includeDisabled || enabled.has(id)).map((id) => {
      const m = manifests[id] ?? {};
      return `- ${m.name ?? id} (${id}) \u2014 ${enabled.has(id) ? "enabled" : "disabled"}${m.version ? `, v${m.version}` : ""}`;
    });
    return lines.length ? lines.join("\n") : "No installed community plugins were found.";
  }
  pluginInfo(query) {
    const q = String(query ?? "").toLowerCase().trim();
    if (!q) return "Plugin id or name is required.";
    const plugins = this.app.plugins;
    const manifests = plugins?.manifests ?? {};
    const enabled = new Set(Object.keys(plugins?.plugins ?? {}));
    const id = Object.keys(manifests).find((k) => {
      const m = manifests[k] ?? {};
      return k.toLowerCase() === q || String(m.name ?? "").toLowerCase().includes(q);
    });
    if (!id) return `Plugin not found: ${query}`;
    return JSON.stringify({ id, enabled: enabled.has(id), ...manifests[id] }, null, 2);
  }
  findImages(folder, query, limit) {
    const root = this.app.vault.getRoot();
    let base = root;
    if (folder && folder !== "vault") {
      const f = this.app.vault.getAbstractFileByPath(safeVaultPath(folder));
      if (f instanceof import_obsidian3.TFolder) base = f;
      else return `Folder not found: ${folder}`;
    }
    const q = String(query ?? "").toLowerCase().trim();
    const out = [];
    VaultWalker(base, (file) => {
      if (out.length >= limit) return;
      if (!isImageName(file.path)) return;
      if (q && !file.path.toLowerCase().includes(q)) return;
      const stat = file.stat;
      out.push(`- ${file.path}${stat?.size ? ` (${Math.round(stat.size / 1024)} KB)` : ""}`);
    });
    return out.length ? out.join("\n") : "No matching images found.";
  }
};
function flattenDuckTopics(items) {
  const out = [];
  for (const item of items) {
    if (item.Topics) out.push(...flattenDuckTopics(item.Topics));
    else out.push(item);
  }
  return out;
}
function truncateText(s, n) {
  return s.length > n ? s.slice(0, n) + "\n\u2026(truncated)" : s;
}
function stripHtml(s) {
  return String(s ?? "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}
function parseDuckHtml(html) {
  const out = [];
  const snippets = [];
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let sm;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripHtml(sm[1]));
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  let idx = 0;
  while ((m = linkRe.exec(html)) !== null) {
    let href = m[1];
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) {
      try {
        href = decodeURIComponent(uddg[1]);
      } catch {
      }
    } else if (href.startsWith("//")) {
      href = "https:" + href;
    }
    const title = stripHtml(m[2]);
    if (title && href) out.push({ title, url: href, snippet: snippets[idx] ?? "" });
    idx++;
  }
  return out;
}
function isImageName(name) {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
}
function safeVaultPath(input, markdownOnly = false) {
  const raw = String(input ?? "").trim().replace(/\\/g, "/");
  if (!raw) throw new Error("A vault-relative path is required.");
  if (/^(?:[a-z]+:|\/|~)/i.test(raw)) throw new Error("Only paths inside the Obsidian vault are allowed.");
  const parts = raw.split("/").filter((p2) => p2 && p2 !== ".");
  if (parts.some((p2) => p2 === "..")) throw new Error("Parent path traversal (..) is not allowed.");
  const p = parts.join("/");
  const first = (parts[0] ?? "").toLowerCase();
  if ([".obsidian", ".trash", ".agenter-backups"].includes(first)) {
    throw new Error("System and backup folders are protected.");
  }
  if (markdownOnly && !p.toLowerCase().endsWith(".md")) {
    throw new Error("This tool can only access markdown notes (.md). ");
  }
  return p;
}
function clampLimit(value, max) {
  const n = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 50;
  return Math.max(1, Math.min(max, n));
}
function frontmatterTags(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/[ ,]+/).filter(Boolean);
  return [];
}
async function ensureFolder(app, folder) {
  const clean = folder.split("/").filter(Boolean);
  let current = "";
  for (const part of clean) {
    current = current ? `${current}/${part}` : part;
    const found = app.vault.getAbstractFileByPath(current);
    if (!found) await app.vault.createFolder(current);
    else if (!(found instanceof import_obsidian3.TFolder)) throw new Error(`Not a folder: ${current}`);
  }
}
async function ensureParentFolder(app, path) {
  const idx = path.lastIndexOf("/");
  if (idx > 0) await ensureFolder(app, path.slice(0, idx));
}
async function createSafetyBackup(app, file, reason) {
  const folder = ".agenter-backups";
  if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const safeName = file.path.replace(/[^a-zA-Z0-9._\u0600-\u06FF-]+/g, "_");
  let backup = `${folder}/${safeName}.${reason}.${stamp}.md`;
  if (app.vault.getAbstractFileByPath(backup)) backup = `${folder}/${safeName}.${reason}.${Date.now()}.md`;
  await app.vault.create(backup, await app.vault.read(file));
  return backup;
}
function resolveSibling(file, name) {
  const dir = file.parent ? file.parent.path : "";
  const clean = name.replace(/^\.\//, "");
  return dir ? `${dir}/${clean}` : clean;
}
function VaultWalker(node, visit) {
  if (node instanceof import_obsidian3.TFolder) {
    for (const child of node.children) VaultWalker(child, visit);
  } else if (node instanceof import_obsidian3.TFile) {
    visit(node);
  }
}
function mimeFromName(name) {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}
function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

// src/orchestrator.ts
var AgentOrchestrator = class {
  constructor(app, settings) {
    this.messages = [];
    this.shouldAbort = () => false;
    this.app = app;
    this.settings = settings;
    this.toolRegistry = new ToolRegistry(app);
  }
  setMessages(messages) {
    this.messages = messages;
  }
  async run(userInput, cb) {
    const provider = getActiveProvider(this.settings);
    if (!provider || !provider.apiKey) {
      cb.onError(
        "No active provider or missing API key. Open Agenter settings and configure a provider."
      );
      cb.onDone();
      return;
    }
    const systemMsg = {
      role: "system",
      content: this.settings.systemPrompt
    };
    const conversation = [
      systemMsg,
      ...this.messages,
      { role: "user", content: userInput }
    ];
    const tools = this.toolRegistry.getDefinitions().filter((tool) => tool.name !== "get_note_images" || provider.supportsVision).filter((tool) => tool.name !== "find_images" || provider.supportsVision);
    const adapter = createProvider(provider, {
      maxTokens: this.settings.maxTokens,
      temperature: this.settings.temperature
    });
    try {
      await this.loop(adapter, tools, conversation, cb);
    } catch (e) {
      cb.onError(e?.message ?? String(e));
    }
    cb.onDone();
  }
  async loop(adapter, tools, conversation, cb) {
    for (let round = 0; round < 6; round++) {
      if (this.shouldAbort()) return;
      let assistantText = "";
      let toolCalls = [];
      await adapter.chat(conversation, tools, {
        onToken: (t) => {
          if (this.shouldAbort()) return;
          assistantText += t;
          cb.onAssistantToken(t);
        },
        onToolCalls: (calls) => {
          toolCalls = calls;
        },
        onDone: () => {
        },
        onError: (err) => {
          throw err;
        }
      });
      if (this.shouldAbort()) return;
      const assistantMsg = {
        role: "assistant",
        content: assistantText,
        tool_calls: toolCalls.length ? toolCalls : void 0
      };
      const webSearchRequested = false;
      conversation.push(assistantMsg);
      if (toolCalls.length === 0) {
        this.messages = conversation.slice(1);
        return;
      }
      for (const call of toolCalls) {
        if (this.shouldAbort()) return;
        cb.onToolUse(call.name, call.arguments);
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
              tool_call_id: call.id
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
          tool_name: call.name
        });
      }
    }
    cb.onError("Reached maximum tool-call rounds without a final answer.");
  }
};

// src/ui.ts
var TOOL_LABELS = {
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
  trash_note: { icon: "trash", verb: "Move note to Trash" }
};
var FloatingChatPanel = class {
  constructor(plugin, options = {}) {
    this.messages = [];
    this.busy = false;
    this.aborted = false;
    this.pos = { x: 120, y: 120 };
    this.minimized = false;
    this.sidebarOpen = false;
    this.streamBuf = "";
    this.streamEl = null;
    this.streamRenderTimer = null;
    this.sidebarListEl = null;
    this.pendingTool = null;
    this.startedAt = 0;
    this.statusTimer = null;
    this.statusResetTimer = null;
    this.hadError = false;
    this.destroyed = false;
    this.plugin = plugin;
    this.app = plugin.app;
    this.options = options;
    this.component = new import_obsidian4.Component();
    this.component.load();
    this.scope = plugin.settings.defaultContextScope;
    this.mode = options.mode ?? "floating";
    this.orchestrator = new AgentOrchestrator(this.app, plugin.settings);
    this.build();
    this.loadActiveSession();
  }
  // ================================================================ build
  build() {
    const root = document.createElement("div");
    root.addClass("agenter-root");
    root.setAttribute("aria-label", "Agenter chat");
    this.rootEl = root;
    this.buildHeader(root);
    this.buildStatus(root);
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
  mountDocked() {
    this.rootEl.addClass("is-docked");
    this.rootEl.removeClass("is-floating");
    this.rootEl.addClass("is-native-view");
    const mountEl = this.options.mountEl ?? document.body;
    mountEl.appendChild(this.rootEl);
  }
  mountFloating() {
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
    this.makeDraggable(this.rootEl.querySelector(".agenter-header"));
  }
  // ------------------------------------------------------------- header
  buildHeader(root) {
    const header = document.createElement("div");
    header.addClass("agenter-header");
    const left = document.createElement("div");
    left.addClass("agenter-header-left");
    const hamburger = mkIconBtn(
      "menu",
      "Toggle chat history",
      () => this.toggleSidebar()
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
    header.appendChild(left);
    const controls = document.createElement("div");
    controls.addClass("agenter-controls");
    const stopBtn = mkIconBtn("square", "Stop generating", () => this.abort());
    stopBtn.addClass("agenter-stop");
    stopBtn.setCssStyles({ display: "none" });
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
    header._stopBtn = stopBtn;
    root.appendChild(header);
  }
  buildStatus(root) {
    const status = document.createElement("div");
    status.addClass("agenter-status", "is-idle");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const icon = document.createElement("span");
    icon.addClass("agenter-status-icon");
    safeIcon(icon, "circle-check", "\u2713");
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
  buildSidebar(body) {
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
  renderSessionList() {
    const list = this.sidebarEl.querySelector(".agenter-session-list");
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
  toggleSidebar() {
    this.sidebarOpen = !this.sidebarOpen;
    this.rootEl.toggleClass("is-sidebar-open", this.sidebarOpen);
  }
  // -------------------------------------------------------- session ops
  currentSession() {
    return getActiveSession(this.plugin.settings);
  }
  async newSession() {
    await this.persist();
    const session = {
      id: genId(),
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
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
  async switchSession(id) {
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
  renameSession(session) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = session.title;
    input.addClass("agenter-rename-input");
    const item = this.sidebarEl.querySelector(".agenter-session-item.is-active") ?? Array.from(this.sidebarEl.querySelectorAll(".agenter-session-item")).find(
      (el) => el.querySelector(".agenter-session-title")?.textContent === session.title
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
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      }
      if (e.key === "Escape") this.renderSessionList();
    });
    input.addEventListener("blur", commit);
    if (item) {
      const label = item.querySelector(".agenter-session-label");
      label.empty();
      label.appendChild(input);
      input.focus();
      input.select();
    }
  }
  async deleteSession(id) {
    const sessions = this.plugin.settings.sessions;
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    sessions.splice(idx, 1);
    if (this.plugin.settings.activeSessionId === id) {
      this.plugin.settings.activeSessionId = sessions[0]?.id ?? "";
      getActiveSession(this.plugin.settings);
      this.loadActiveSession();
    }
    await this.plugin.saveSettings();
    this.renderSessionList();
  }
  // ----------------------------------------------------------- messages
  buildMessages(root) {
    const messages = document.createElement("div");
    messages.addClass("agenter-messages");
    root.appendChild(messages);
    this.messagesEl = messages;
  }
  buildInput(root) {
    const inputWrap = document.createElement("div");
    inputWrap.addClass("agenter-input-wrap");
    const composer = document.createElement("div");
    composer.addClass("agenter-composer");
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
        this.inputEl.value = this.inputEl.value ? `${this.inputEl.value}

${sel}` : sel;
        this.autoGrow();
        this.inputEl.focus();
      } else {
        new import_obsidian4.Notice("No text selected in the active note.");
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
  openActionMenu(anchor) {
    const menu = new import_obsidian4.Menu();
    const prompts = this.plugin.settings.customPrompts ?? {};
    const addPrompt = (label, prompt) => {
      menu.addItem(
        (item) => item.setTitle(label).onClick(() => {
          this.insertPrompt(prompt);
          this.inputEl.focus();
        })
      );
    };
    const builtInLabels = {
      summarize: "Summarize selection",
      rewrite: "Rewrite selection",
      extract: "Extract tasks"
    };
    const promptEntries = Object.entries(prompts);
    for (const [key, template] of promptEntries) {
      const label = builtInLabels[key] ?? key.replace(/[-_]/g, " ");
      addPrompt(label, String(template));
    }
    menu.addSeparator();
    menu.addItem(
      (item) => item.setTitle("Open settings").onClick(() => {
        this.plugin.app.setting.open();
        this.plugin.app.setting.openTabById("agenter");
      })
    );
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }
  openContextMenu(anchor, labelEl) {
    const menu = new import_obsidian4.Menu();
    ["note", "folder", "vault", "none"].forEach((scope) => {
      menu.addItem(
        (item) => item.setTitle(`${scope === "note" ? this.currentNoteLabel() : scope}`).setChecked(scope === this.scope).onClick(() => {
          this.scope = scope;
          labelEl.textContent = this.contextLabel();
          const icon = anchor.querySelector("svg")?.parentElement ?? anchor;
          safeIcon(icon, this.scopeIcon(scope));
        })
      );
    });
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }
  openModelMenu(anchor) {
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
    const addNumericControl = (labelText, min, max, step, value, onValue) => {
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
      const apply = (raw, commit = false) => {
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
        if (e.key === "Enter") {
          apply(number.value, true);
          number.blur();
        }
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
    addNumericControl("Max tokens", 256, 128e3, 256, this.plugin.settings.maxTokens, (v) => {
      this.plugin.settings.maxTokens = Math.round(v);
    });
    const full = document.createElement("button");
    full.addClass("agenter-model-full-settings");
    full.textContent = "Open full model settings";
    full.addEventListener("click", () => {
      pop.remove();
      this.plugin.app.setting.open();
      this.plugin.app.setting.openTabById("agenter");
    });
    pop.appendChild(full);
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    const width = 320;
    const left = Math.max(10, Math.min(rect.left, window.innerWidth - width - 10));
    pop.setCssStyles({ left: `${left}px` });
    const estimatedHeight = 250;
    const below = rect.bottom + 7;
    pop.setCssStyles({ top: `${below + estimatedHeight > window.innerHeight ? Math.max(10, rect.top - estimatedHeight - 7) : below}px` });
    const close = (e) => {
      if (!pop.contains(e.target) && !anchor.contains(e.target)) {
        pop.remove();
        document.removeEventListener("mousedown", close, true);
      }
    };
    window.setTimeout(() => document.addEventListener("mousedown", close, true), 0);
  }
  contextLabel() {
    if (this.scope === "note") return this.currentNoteLabel();
    if (this.scope === "folder") {
      const folder = this.app.workspace.getActiveFile()?.parent?.path || "folder";
      return folder === "/" ? "folder" : folder;
    }
    return this.scope;
  }
  currentNoteLabel() {
    const file = this.app.workspace.getActiveFile();
    return file?.basename || file?.name || "current note";
  }
  scopeIcon(scope) {
    if (scope === "folder") return "folder";
    if (scope === "vault") return "database";
    if (scope === "none") return "x";
    return "file-text";
  }
  insertPrompt(text) {
    const prefix = this.inputEl.value.trim();
    this.inputEl.value = prefix && prefix !== "/" ? `${prefix}
${text}` : text;
    this.autoGrow();
    this.inputEl.focus();
    const end = this.inputEl.value.length;
    this.inputEl.setSelectionRange(end, end);
  }
  insertPromptFromOutside(text) {
    this.insertPrompt(text);
  }
  submitPromptFromOutside(text) {
    this.insertPrompt(text);
    void this.send();
  }
  /** Reload the active session into this panel (used when a contextual chat
   *  hands its conversation back to the main panel). */
  reloadActiveSession() {
    this.loadActiveSession();
    this.renderSessionList();
  }
  moveNear(x, y) {
    if (this.mode !== "floating") return;
    const width = this.rootEl.offsetWidth || this.plugin.settings.panelWidth || 420;
    const height = this.rootEl.offsetHeight || this.plugin.settings.panelHeight || 600;
    this.pos.x = Math.max(10, Math.min(x + 12, window.innerWidth - width - 10));
    this.pos.y = Math.max(10, Math.min(y + 12, window.innerHeight - height - 10));
    this.rootEl.setCssStyles({ left: `${this.pos.x}px`, top: `${this.pos.y}px` });
    this.inputEl.focus();
  }
  autoGrow() {
    const el = this.inputEl;
    el.setCssStyles({ height: "auto" });
    el.setCssStyles({ height: Math.min(el.scrollHeight, 160) + "px" });
  }
  // ----------------------------------------------------- provider menu
  refreshProviderLabel() {
    const p = getActiveProvider(this.plugin.settings);
    this.providerBtn.setText(p ? `${p.name}` : "no provider");
  }
  openProviderMenu(anchor) {
    const menu = new import_obsidian4.Menu();
    this.plugin.settings.providers.forEach((p) => {
      menu.addItem(
        (item) => item.setTitle(`${p.name} \u2014 ${p.model}`).setChecked(p.id === this.plugin.settings.activeProviderId).onClick(async () => {
          this.plugin.settings.activeProviderId = p.id;
          await this.plugin.saveSettings();
          this.refreshProviderLabel();
          this.appendSystem(`Switched to **${p.name} / ${p.model}**`);
        })
      );
      menu.addItem(
        (item) => item.setTitle(`  \u21B3 Fetch & pick model for ${p.name}`).onClick(async () => {
          const res = await probeModels(p);
          if (!res.ok) {
            new import_obsidian4.Notice(`\u274C ${p.name}: ${res.error ?? "failed"}`);
            return;
          }
          if (!res.models.length) {
            new import_obsidian4.Notice(`\u2705 ${p.name}: connected (no model list)`);
            return;
          }
          const mMenu = new import_obsidian4.Menu();
          res.models.forEach((m) => {
            mMenu.addItem(
              (mi) => mi.setTitle(m).setChecked(m === p.model).onClick(async () => {
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
            y: anchor.getBoundingClientRect().bottom + 4
          });
        })
      );
    });
    menu.addSeparator();
    menu.addItem(
      (item) => item.setTitle("Open settings\u2026").onClick(() => {
        this.plugin.app.setting.open();
        this.plugin.app.setting.openTabById("agenter");
      })
    );
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }
  // --------------------------------------------------------- history I/O
  loadActiveSession() {
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
        this.appendMessage(m.role, m.content);
        this.messages.push({ role: m.role, content: m.content });
      }
    }
    this.scrollToBottom();
  }
  async persist() {
    const session = this.currentSession();
    const stored = [];
    this.messagesEl.querySelectorAll(".agenter-msg, .agenter-tool-line").forEach((el) => {
      const e = el;
      if (e.classList.contains("agenter-tool-line")) {
        stored.push({
          role: "tool",
          content: e.dataset.raw ?? "",
          toolName: e.dataset.toolName
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
  addWelcome() {
    const provider = getActiveProvider(this.plugin.settings);
    const name = provider ? `${provider.name} / ${provider.model}` : "no provider configured";
    this.appendMessage(
      "assistant",
      `Hi! I'm **Agenter**, connected to **${name}**.

I can read, write, edit, and summarize your notes, search the web, and look at images inside your notes. When I want to change a note I'll show you an action card to approve first.

Pick a context scope above, then ask me anything.`
    );
  }
  /** Render a user/assistant message bubble with markdown. */
  appendMessage(role, text) {
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
  appendSystem(text) {
    const el = document.createElement("div");
    el.addClass("agenter-msg-system");
    el.dataset.raw = text;
    this.renderMarkdown(text, el);
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
    return el;
  }
  /** A compact one-line indicator that a (non-mutating) tool ran. */
  appendToolLine(name, result, args = {}) {
    const el = document.createElement("div");
    el.addClass("agenter-tool-line");
    el.dataset.toolName = name;
    el.dataset.raw = result;
    const documentTools = /* @__PURE__ */ new Set(["read_note", "read_note_section", "summarize_note", "current_note"]);
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
  renderMarkdown(text, target, sourcePath = "") {
    target.empty();
    target.addClass("markdown-rendered");
    target.setAttribute("dir", detectTextDirection(text));
    import_obsidian4.MarkdownRenderer.render(this.app, text, target, sourcePath, this.component).catch(() => {
      target.setText(text);
    });
  }
  showTyping() {
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
    typing.empty();
    typing.createSpan();
    typing.createSpan();
    typing.createSpan();
    bubble.appendChild(typing);
    wrap.appendChild(bubble);
    this.messagesEl.appendChild(wrap);
    this.scrollToBottom();
    return wrap;
  }
  beginActivity() {
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
  setStatus(state, text, meta = "") {
    this.statusEl.className = `agenter-status is-${state}`;
    this.statusTextEl.textContent = text;
    this.statusMetaEl.textContent = meta;
    const icon = state === "error" ? "circle-alert" : state === "done" ? "circle-check" : state === "approval" ? "shield-question" : state === "tool" ? "wrench" : state === "idle" ? "circle" : "loader-circle";
    safeIcon(this.statusIconEl, icon, state === "error" ? "!" : "\u2022");
  }
  finishActivity(label = "Completed") {
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
  clearStatusTimers() {
    if (this.statusTimer !== null) {
      window.clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.statusResetTimer !== null) {
      window.clearTimeout(this.statusResetTimer);
      this.statusResetTimer = null;
    }
  }
  formatElapsed(ms) {
    if (ms < 1e3) return `${Math.max(0, Math.round(ms))} ms`;
    return `${(ms / 1e3).toFixed(ms < 1e4 ? 1 : 0)} s`;
  }
  scheduleStreamRender() {
    if (this.streamRenderTimer !== null) return;
    this.streamRenderTimer = window.setTimeout(() => {
      this.streamRenderTimer = null;
      this.flushStreamRender();
    }, 40);
  }
  flushStreamRender() {
    if (!this.streamEl) return;
    const bubble = this.streamEl.querySelector(".agenter-bubble");
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
  requestApproval(call) {
    return new Promise((resolve) => {
      this.setStatus("approval", "Waiting for approval", TOOL_LABELS[call.name]?.verb ?? call.name);
      let args = {};
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {
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
      title.empty();
      title.createEl("strong", { text: meta.verb });
      if (args.path) {
        const path = document.createElement("div");
        path.addClass("agenter-action-path");
        path.textContent = args.path;
        title.appendChild(path);
      }
      head.appendChild(title);
      card.appendChild(head);
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
      const settle = (ok) => {
        actions.remove();
        const status = document.createElement("div");
        status.addClass("agenter-action-status", ok ? "is-approved" : "is-rejected");
        status.textContent = ok ? "\u2713 Approved" : "\u2715 Rejected";
        card.appendChild(status);
        card.addClass(ok ? "is-approved" : "is-rejected");
        this.setStatus("thinking", ok ? "Continuing" : "Handling rejection");
        resolve(ok);
      };
      let armed = false;
      let armTimer = null;
      approve.addEventListener("click", () => {
        if (!destructive) {
          settle(true);
          return;
        }
        if (!armed) {
          armed = true;
          card.addClass("is-armed");
          approve.textContent = "Click again: Move to Trash";
          armTimer = window.setTimeout(() => {
            armed = false;
            card.removeClass("is-armed");
            approve.textContent = "Review deletion";
          }, 6e3);
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
  approvalPreview(name, args) {
    if (name === "append_note") return truncate(args.content ?? "", 600);
    if (name === "write_note") return truncate(args.content ?? "", 600);
    if (name === "edit_note") {
      return `- ${truncate(args.old_string ?? "", 260)}
+ ${truncate(args.new_string ?? "", 260)}`;
    }
    if (name === "create_folder") return `Create folder inside vault:
${args.path ?? ""}`;
    if (name === "move_note") return `From: ${args.path ?? ""}
To: ${args.destination ?? ""}

A safety backup will be created first.`;
    if (name === "trash_note") return `Move this note to recoverable Obsidian Trash:
${args.path ?? ""}

A safety backup will be created inside .agenter-backups first. Permanent deletion is not used.`;
    return "";
  }
  // --------------------------------------------------------------- send
  async send() {
    if (this.busy) return;
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    this.autoGrow();
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
    const prompt = contextNote ? `${contextNote}

${text}` : text;
    this.orchestrator.setMessages(this.messages.slice(0, -1));
    this.orchestrator.shouldAbort = () => this.aborted;
    this.streamBuf = "";
    this.streamEl = null;
    let pendingTool = null;
    let pendingToolArgs = {};
    const cb = {
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
        this.streamEl = null;
        this.streamBuf = "";
        pendingTool = name;
        try {
          pendingToolArgs = JSON.parse(args || "{}");
        } catch {
          pendingToolArgs = {};
        }
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
      }
    };
    await this.orchestrator.run(prompt, cb);
    if (!this.aborted && this.orchestrator.messages.length) {
      this.messages = this.orchestrator.messages;
    }
  }
  syncMessages() {
    const msgs = [];
    this.messagesEl.querySelectorAll(".agenter-msg").forEach((el) => {
      const e = el;
      if (e.classList.contains("is-typing")) return;
      if (e.classList.contains("agenter-msg-user"))
        msgs.push({ role: "user", content: e.dataset.raw ?? "" });
      else if (e.classList.contains("agenter-msg-assistant"))
        msgs.push({ role: "assistant", content: e.dataset.raw ?? "" });
    });
    this.messages = msgs;
  }
  abort() {
    this.aborted = true;
    this.sendBtn.disabled = false;
    this.toggleStop(false);
    this.finishActivity("Stopped");
  }
  toggleStop(show) {
    const header = this.rootEl.querySelector(".agenter-header");
    const stop = header?._stopBtn;
    if (stop) stop.setCssStyles({ display: show ? "flex" : "none" });
  }
  // ------------------------------------------------------------ context
  buildContextNote() {
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
  toggleMode() {
    void this.persist();
    if (this.mode === "docked") this.options.onRequestFloat?.();
    else this.options.onRequestDock?.();
  }
  toggleMinimize() {
    this.minimized = !this.minimized;
    this.rootEl.toggleClass("is-minimized", this.minimized);
    if (this.minimized) {
      this.rootEl.setCssStyles({ height: "auto" });
    } else {
      this.rootEl.setCssStyles({
        height: this.mode === "floating" ? `${this.plugin.settings.panelHeight}px` : "100vh"
      });
    }
  }
  makeDraggable(handle) {
    let dragging = false;
    let offX = 0;
    let offY = 0;
    handle.addEventListener("mousedown", (e) => {
      if (this.mode !== "floating" || this.minimized) return;
      if (e.target.closest("button")) return;
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
  scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
  getEditorSelection() {
    try {
      const view = this.app.workspace.getActiveViewOfType(import_obsidian4.MarkdownView);
      if (view && view.editor) {
        const sel = view.editor.getSelection();
        return sel && sel.trim() ? sel.trim() : null;
      }
    } catch {
    }
    const s = window.getSelection();
    const txt = s ? s.toString().trim() : "";
    return txt || null;
  }
  close() {
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
};
function safeIcon(el, icon, fallback = "\u2022") {
  const paths = {
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
    circle: '<circle cx="12" cy="12" r="6"/>'
  };
  const path = paths[icon];
  el.empty();
  if (!path) {
    el.setText(fallback);
    el.setCssStyles({ fontSize: "16px", lineHeight: "1" });
    return;
  }
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const elRe = /<([a-zA-Z]+)([^>]*?)\/?>(?:<\/[a-zA-Z]+>)?/g;
  const attrRe = /([a-zA-Z-]+)="([^"]*)"/g;
  let elMatch;
  while ((elMatch = elRe.exec(path)) !== null) {
    const child = document.createElementNS(NS, elMatch[1]);
    let attrMatch;
    while ((attrMatch = attrRe.exec(elMatch[2])) !== null) {
      child.setAttribute(attrMatch[1], attrMatch[2]);
    }
    svg.appendChild(child);
  }
  el.appendChild(svg);
}
function mkIconBtn(icon, title, onClick) {
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
function detectTextDirection(text) {
  const plain = String(text ?? "").replace(/^[#>*_`~\-+\d.\s]+/, "");
  const rtl = plain.search(/[\u0590-\u08FF]/);
  const ltr = plain.search(/[A-Za-z]/);
  return rtl >= 0 && (ltr < 0 || rtl < ltr) ? "rtl" : "ltr";
}
function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "\u2026" : s;
}

// main.ts
var AGENTER_VIEW_TYPE = "agenter-chat-view";
function safeIconHtml(el, icon) {
  const paths = {
    sparkles: "M12 3l1.7 5.2L19 10l-5.3 1.8L12 17l-1.7-5.2L5 10l5.3-1.8z",
    x: "M6 6l12 12M18 6L6 18"
  };
  el.empty();
  const d = paths[icon];
  if (!d) {
    el.setText("\u2022");
    return;
  }
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", d);
  svg.appendChild(p);
  el.appendChild(svg);
}
var AgenterChatView = class extends import_obsidian5.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.panel = null;
  }
  getViewType() {
    return AGENTER_VIEW_TYPE;
  }
  getDisplayText() {
    return "Agenter";
  }
  getIcon() {
    return "message-square";
  }
  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("agenter-view-content");
    this.panel = new FloatingChatPanel(this.plugin, {
      mode: "docked",
      mountEl: this.contentEl,
      onRequestFloat: () => void this.plugin.openFloatingChat(),
      onRequestClose: () => void this.leaf.detach()
    });
    this.plugin.activeChatPanel = this.panel;
  }
  async onClose() {
    if (this.plugin.activeChatPanel === this.panel) {
      this.plugin.activeChatPanel = null;
    }
    this.panel?.destroy();
    this.panel = null;
    this.contentEl.removeClass("agenter-view-content");
  }
};
var AgenterPlugin = class extends import_obsidian5.Plugin {
  constructor() {
    super(...arguments);
    this.activeChatPanel = null;
    this.pendingPrompt = "";
    this.floatingPanel = null;
    this.selectionTimer = null;
  }
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
      callback: () => void this.openDockedChat()
    });
    this.addCommand({
      id: "open-floating-chat",
      name: "Open floating chat",
      callback: () => void this.openFloatingChat()
    });
    this.addCommand({
      id: "close-chat",
      name: "Close chat",
      callback: () => this.closeAllPanels()
    });
    this.addCommand({
      id: "ai-action-on-selection",
      name: "Run AI action on selection",
      editorCallback: (editor) => {
        const sel = editor.getSelection();
        if (sel && sel.trim()) {
          this.showSelectionAI(editor, sel.trim());
        } else {
          new import_obsidian5.Notice("Select some text first.");
        }
      }
    });
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const sel = editor.getSelection();
        if (sel && sel.trim()) {
          menu.addItem((item) => {
            item.setTitle("Agenter: AI actions").setIcon("sparkles").onClick(() => this.showSelectionAI(editor, sel.trim()));
          });
        }
      })
    );
    this.registerDomEvent(document, "mouseup", (event) => {
      this.scheduleSelectionAI(event);
    });
    this.registerDomEvent(document, "keyup", (event) => {
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
    let leaf = this.app.workspace.getLeavesOfType(AGENTER_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        new import_obsidian5.Notice("Agenter could not open the right sidebar.");
        return;
      }
      await leaf.setViewState({ type: AGENTER_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }
  async openFloatingChat(position) {
    this.app.workspace.detachLeavesOfType(AGENTER_VIEW_TYPE);
    if (!this.floatingPanel) {
      this.floatingPanel = new FloatingChatPanel(this, {
        mode: "floating",
        onRequestDock: () => void this.openDockedChat(),
        onRequestClose: () => this.closeFloatingPanel()
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
  scheduleSelectionAI(event) {
    const target = event.target;
    if (target?.closest?.(".agenter-root, .agenter-selection-popover, .menu, .modal-container")) return;
    if (this.selectionTimer !== null) window.clearTimeout(this.selectionTimer);
    this.selectionTimer = window.setTimeout(() => {
      this.selectionTimer = null;
      const view = this.app.workspace.getActiveViewOfType(import_obsidian5.MarkdownView);
      const editor = view?.editor;
      const selection = editor?.getSelection?.()?.trim?.() ?? "";
      if (!selection) {
        document.querySelector(".agenter-selection-popover")?.remove();
        return;
      }
      const cursor = editor.cursorCoords?.("to") ?? editor.cursorCoords?.();
      const point = {
        x: cursor?.left ?? (event instanceof MouseEvent ? event.clientX : window.innerWidth / 2),
        y: cursor?.bottom ?? (event instanceof MouseEvent ? event.clientY : window.innerHeight / 2)
      };
      this.showSelectionAI(editor, selection, point);
    }, 90);
  }
  /** Contextual third chat mode: compact, selection-anchored, and self-contained. */
  showSelectionAI(editor, selection, point) {
    const cursor = editor.cursorCoords ? editor.cursorCoords("to") : null;
    const x = point?.x ?? cursor?.left ?? window.innerWidth / 2;
    const y = point?.y ?? cursor?.bottom ?? window.innerHeight / 2;
    document.querySelector(".agenter-selection-popover")?.remove();
    const popover = document.createElement("div");
    popover.addClass("agenter-selection-popover", "is-contextual");
    const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
    const renderComponent = new import_obsidian5.Component();
    renderComponent.load();
    let popoverWasConnected = false;
    const lifecycleObserver = new MutationObserver(() => {
      if (popover.isConnected) {
        popoverWasConnected = true;
        return;
      }
      if (popoverWasConnected) {
        renderComponent.unload();
        lifecycleObserver.disconnect();
      }
    });
    lifecycleObserver.observe(document.body, { childList: true, subtree: true });
    const renderMd = (text, target) => {
      target.empty();
      target.addClass("markdown-rendered");
      target.dir = /[\u0590-\u08FF]/.test(text) ? "rtl" : "ltr";
      import_obsidian5.MarkdownRenderer.render(this.app, text, target, sourcePath, renderComponent).catch(() => {
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
    closeBtn.textContent = "\xD7";
    closeBtn.setAttribute("aria-label", "Close contextual chat");
    closeBtn.addEventListener("click", () => popover.remove());
    head.appendChild(closeBtn);
    popover.appendChild(head);
    const previewShell = document.createElement("section");
    previewShell.addClass("agenter-selection-preview-shell");
    const previewTop = document.createElement("button");
    previewTop.addClass("agenter-selection-preview-top");
    const contextLabel = document.createElement("span");
    contextLabel.textContent = `Selection \xB7 ${selection.split("\n").length} lines`;
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
    input.placeholder = "Ask about selection\u2026";
    const send = document.createElement("button");
    send.setAttribute("aria-label", "Send in contextual chat");
    send.textContent = "\u2191";
    composer.append(input, send);
    popover.appendChild(composer);
    const orchestrator = new AgentOrchestrator(this.app, this.settings);
    const session = getActiveSession(this.settings);
    orchestrator.setMessages(
      session.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content }))
    );
    const persistToSession = async () => {
      const stored = [];
      for (const m of orchestrator.messages) {
        if (m.role === "user") stored.push({ role: "user", content: m.content ?? "" });
        else if (m.role === "assistant" && (m.content ?? "").trim())
          stored.push({ role: "assistant", content: m.content });
        else if (m.role === "tool")
          stored.push({ role: "tool", content: m.content ?? "", toolName: m.tool_name });
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
      input.placeholder = "Continue here\u2026";
      if (!hydrated) {
        hydrated = true;
        for (const m of session.messages) {
          if (m.role === "user") appendBubble("user", m.content);
          else if (m.role === "assistant" && (m.content ?? "").trim())
            appendBubble("assistant", m.content);
        }
      }
      window.requestAnimationFrame(() => {
        position();
        input.focus();
      });
    };
    const appendBubble = (role, text) => {
      const bubble = document.createElement("div");
      bubble.addClass("agenter-selection-chat-message", `is-${role}`);
      if (role === "status") bubble.setText(text);
      else renderMd(text, bubble);
      chatLog.appendChild(bubble);
      chatLog.scrollTop = chatLog.scrollHeight;
      return bubble;
    };
    const requestInlineApproval = (call) => new Promise((resolve) => {
      let a = {};
      try {
        a = JSON.parse(call.arguments || "{}");
      } catch {
      }
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
      const settle = (ok) => {
        row.remove();
        const st = document.createElement("div");
        st.addClass("agenter-selection-approval-status");
        st.textContent = ok ? "\u2713 Approved" : "\u2715 Rejected";
        card.appendChild(st);
        resolve(ok);
      };
      let armed = false;
      let armTimer = null;
      approve.addEventListener("click", () => {
        if (!destructive) {
          settle(true);
          return;
        }
        if (!armed) {
          armed = true;
          approve.textContent = "Click again: Move to Trash";
          armTimer = window.setTimeout(() => {
            armed = false;
            approve.textContent = "Review deletion";
          }, 6e3);
          return;
        }
        if (armTimer !== null) window.clearTimeout(armTimer);
        settle(true);
      });
      reject.addEventListener("click", () => settle(false));
    });
    const runInline = async (question) => {
      const clean = question.trim();
      if (!clean || busy) return;
      enterChatMode();
      busy = true;
      send.disabled = true;
      input.value = "";
      appendBubble("user", clean);
      const typing = appendBubble("status", "Thinking\u2026");
      let response = "";
      let responseEl = null;
      let renderTimer = null;
      const alreadyHasContext = clean.includes(selection);
      const prompt = hasSelectionContext || alreadyHasContext ? clean : `${clean}

<selected-text>
${selection}
</selected-text>`;
      hasSelectionContext = true;
      orchestrator.shouldAbort = () => !document.body.contains(popover);
      const flush = () => {
        if (!responseEl) return;
        renderMd(response, responseEl);
        chatLog.scrollTop = chatLog.scrollHeight;
      };
      const callbacks = {
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
          appendBubble("status", `Using ${name}\u2026`);
        },
        onToolResult: () => {
        },
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
        }
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
        const filled = tmpl.includes("{{selection}}") ? tmpl.replace(/\{\{\s*selection\s*\}\}/g, selection) : tmpl;
        void runInline(filled);
      });
      list.appendChild(btn);
    });
    chatHere.addEventListener("click", () => enterChatMode());
    const submit = () => void runInline(input.value);
    send.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    document.body.appendChild(popover);
    position();
    const onDown = (ev) => {
      if (!popover.contains(ev.target)) {
        popover.remove();
        document.removeEventListener("mousedown", onDown, true);
      }
    };
    window.setTimeout(() => document.addEventListener("mousedown", onDown, true), 0);
  }
  async ensureChatOpen() {
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
        messages: this.settings.chatHistory
      });
      this.settings.chatHistory = [];
    }
    getActiveSession(this.settings);
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AGENTER_VIEW_TYPE
});
