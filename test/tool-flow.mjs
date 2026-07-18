// tool-flow.mjs — verify the send() -> orchestrator -> tool use -> render
// flow works end to end with a mocked provider that emits a tool call.
// This catches the "AI answers but nothing renders / tools never run" bug.
import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";

const root = path.dirname(fileURLToPath(import.meta.url));
const __root = path.join(root, "..");

// --- minimal DOM ---
const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, { pretendToBeVisual: true });
const { window } = dom;
global.window = window;
global.document = window.document;
global.HTMLElement = window.HTMLElement;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

// Polyfill Obsidian's HTMLElement extensions.
function addClass(el, ...c) { c.forEach((x) => el.classList.add(x)); }
function removeClass(el, ...c) { c.forEach((x) => el.classList.remove(x)); }
function toggleClass(el, c, on) { if (on === undefined) el.classList.toggle(c); else if (on) el.classList.add(c); else el.classList.remove(c); }
function hasClass(el, c) { return el.classList.contains(c); }
for (const proto of [window.HTMLElement.prototype]) {
  proto.addClass = function (...c) { addClass(this, ...c); };
  proto.removeClass = function (...c) { removeClass(this, ...c); };
  proto.toggleClass = function (c, on) { toggleClass(this, c, on); };
  proto.hasClass = function (c) { return hasClass(this, c); };
  proto.setText = function (t) { this.textContent = t; };
  proto.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
}

const obsidianMock = `
var TFile = class { constructor(p){ this.path=p; this.parent={path:p.split('/').slice(0,-1).join('/')||''}; this.name=p.split('/').pop(); } };
var TFolder = class { constructor(p){ this.path=p; this.children=[]; } };
var Notice = class { constructor(m){ console.log("[Notice]", m); } };
var requestUrl = async (opts) => {
  const url = opts && opts.url || "";
  if (url.endsWith("/models")) return { status: 200, text: JSON.stringify({ data: [{ id: "gpt-4o" }] }), json: () => ({ data: [{ id: "gpt-4o" }] }) };
  return { status: 200, text: "", json: () => ({}) };
};
var Menu = class {
  addItem(cb){ const it={ setTitle(){return it;}, setChecked(){return it;}, onClick(){return it;} }; cb(it); return this; }
  addSeparator(){} showAtPosition(){}
};
var Modal = class { constructor(){} open(){} close(){} onOpen(){} onClose(){} get contentEl(){ return document.createElement("div"); } };
var Plugin = class { constructor(){ this.app={}; this.settings={}; } addRibbonIcon(){return {};} addCommand(){} addSettingTab(){} loadData(){return {};} saveData(){return Promise.resolve();} };
var WorkspaceLeaf = class {};
var ItemView = class { constructor(leaf){ this.leaf=leaf; this.contentEl=document.createElement("div"); } };
var Setting = class { constructor(){} setName(){return this;} setDesc(){return this;} addText(){return this;} addDropdown(){return this;} addToggle(){return this;} addButton(){return this;} addTextArea(){return this;} };
var PluginSettingTab = class { constructor(){} display(){} };
var setIcon = (el, icon) => { el.textContent = icon; };
var Component = class { load(){} unload(){} registerEvent(){} };
var MarkdownRenderer = class { static render(app, text, el, srcPath, component){ return Promise.resolve().then(()=>{ el.textContent = text; }); } };
var MarkdownView = class {};
export { TFile, TFolder, Notice, requestUrl, Menu, Modal, Plugin, WorkspaceLeaf, ItemView, Setting, PluginSettingTab, setIcon, Component, MarkdownRenderer, MarkdownView };
`;

const entry = `
import AgenterPlugin from "../main";
import { FloatingChatPanel } from "../src/ui";

// Build a fake plugin with one provider + a session.
const plugin = new AgenterPlugin();
plugin.app = {
  workspace: {
    getActiveFile: () => ({ path: "Note.md", parent: { path: "" } }),
    getActiveViewOfType: () => null,
  },
  vault: {
    getAbstractFileByPath: () => null,
    read: async () => "", create: async () => {}, modify: async () => {},
  },
  setting: { open(){}, openTabById(){} },
};
plugin.settings = {
  providers: [{ id:"p1", name:"OpenAI", type:"openai", baseUrl:"https://api.openai.com/v1", apiKey:"x", model:"gpt-4o", extraHeaders:"", supportsWebSearch:true, supportsVision:true }],
  activeProviderId: "p1",
  maxTokens: 4096, temperature: 0.7, systemPrompt: "test", streaming: true, defaultContextScope: "note",
  maxContextNotes: 20, panelWidth: 420, panelHeight: 600, chatHistory: [],
  sessions: [], activeSessionId: "", toolApproval: {},
};

// Patch the orchestrator's provider so it returns a tool call then a final answer.
const { AgentOrchestrator } = await import("../src/orchestrator");
const { createProvider } = await import("../src/api");
const realCreate = createProvider;
// Replace the OpenAI adapter's chat with a scripted one.
import * as apiMod from "../src/api";
apiMod.OpenAIProvider.prototype.chat = async function(messages, tools, cb) {
  // First round: emit a tool_call (read_note).
  cb.onToken("");
  cb.onToolCalls?.([{ id: "call_1", name: "read_note", arguments: JSON.stringify({ path: "Note.md" }) }]);
  cb.onDone();
};
AgentOrchestrator.prototype.run = async function(userInput, cbb) {
  // 1) model asks to use read_note
  cbb.onAssistantToken("");
  cbb.onToolUse("read_note", JSON.stringify({ path: "Note.md" }));
  cbb.onToolResult("Content of Note.md: hello world");
  // 2) model gives final answer
  cbb.onAssistantToken("I read your note. It says: hello world");
  cbb.onDone();
};

const panel = new FloatingChatPanel(plugin);
// Simulate sending a message.
panel["inputEl"].value = "What is in my note?";
await panel["send"]();

// Inspect rendered DOM.
const msgs = document.body.querySelectorAll(".agenter-msg, .agenter-tool-line");
let toolLines = 0, assistantMsgs = 0;
msgs.forEach((el) => {
  if (el.classList.contains("agenter-tool-line")) toolLines++;
  if (el.classList.contains("agenter-msg-assistant")) assistantMsgs++;
});
console.log("RENDERED_NODES:", msgs.length, "toolLines:", toolLines, "assistantMsgs:", assistantMsgs);
console.log(toolLines >= 1 && assistantMsgs >= 1 ? "TOOL_FLOW_OK" : "TOOL_FLOW_FAIL");
`;

const result = await build({
  stdin: { contents: entry, resolveDir: path.join(root), loader: "ts" },
  bundle: true, format: "esm", platform: "node", write: false,
  plugins: [{
    name: "mock-obsidian",
    setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
      b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: obsidianMock, loader: "js" }));
    },
  }],
});

const code = result.outputFiles[0].text;
const dataUrl = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
await import(dataUrl);
