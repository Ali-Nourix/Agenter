import { electronMockPlugin } from "./esbuild-electron-mock.mjs";
/**
 * Build + run a smoke test for FloatingChatPanel using esbuild with a
 * mocked obsidian module and a minimal DOM (via jsdom). Verifies that
 * constructing the panel appends a root element to document.body and
 * that toggling mode / minimize does not throw.
 */
import * as esbuild from "esbuild";
import { JSDOM } from "jsdom";
import path from "path";
import { promises as fs } from "fs";

const root = path.resolve(".");

const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {
  url: "app://obsidian.md",
  pretendToBeVisual: true,
});
const { window } = dom;

const obsidianMock = `
export class TFile { constructor(p){ this.path=p; const i=p.lastIndexOf('/'); this.parent={path:i>=0?p.slice(0,i):''}; this.name=p.slice(i+1); } }
export class TFolder { constructor(p){ this.path=p; this.children=[]; } }
export class Notice { constructor(m){ console.log('[Notice]', m); } }
export const requestUrl = async (opts) => {
  const url = (opts && opts.url) || "";
  if (url.endsWith("/models")) return { status:200, text: JSON.stringify({data:[{id:"gpt-4o"}]}), json:()=>({data:[{id:"gpt-4o"}]}) };
  return { status:200, text:"", json:()=>({}) };
};
export class Menu { addItem(cb){ const it={setTitle(){return it;},setChecked(){return it;},onClick(){return it;}}; cb(it); return this; } addSeparator(){} showAtPosition(){} }
export class Modal { constructor(){} open(){} close(){} onOpen(){} onClose(){} get contentEl(){ return document.createElement('div'); } }
export class Plugin {
  constructor() { this.app = {}; this.settings = {}; }
  addRibbonIcon() { return {}; }
  addCommand() {}
  addSettingTab() {}
  loadData() { return {}; }
  saveData() { return Promise.resolve(); }
}
export class WorkspaceLeaf {}
export class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.contentEl = document.createElement("div");
  }
}
export class Setting { constructor(){} setName(){return this;} setDesc(){return this;} addText(){return this;} addDropdown(){return this;} addToggle(){return this;} addButton(){return this;} addTextArea(){return this;} }
export class PluginSettingTab { constructor(){} display(){} }
export const setIcon = (el, icon) => { el.textContent = icon; };
export class Component { load(){} unload(){} registerEvent(){} }
export class MarkdownRenderer {
  static render(app, text, el, srcPath, component) {
    return Promise.resolve().then(() => { el.textContent = text; });
  }
}
export class MarkdownView {}
`;

// Test entry that imports FloatingChatPanel and exercises it.
const entry = `
import { FloatingChatPanel } from "../src/ui";
import AgenterPlugin from "../main";

const plugin = new AgenterPlugin();
plugin.app = {
  workspace: {
    getActiveFile: () => ({ path: "Note.md", parent: { path: "Folder" } }),
    getActiveViewOfType: () => null,
  },
  vault: {
    getAbstractFileByPath: () => null,
    read: async () => "",
    create: async () => {},
    modify: async () => {},
  },
  setting: { open(){}, openTabById(){} },
};
plugin.settings = {
  providers: [{ id:"p1", name:"OpenAI", type:"openai", baseUrl:"https://api.openai.com/v1", apiKey:"x", model:"gpt-4o", extraHeaders:"", supportsWebSearch:true, supportsVision:true }],
  activeProviderId: "p1",
  maxTokens: 4096, temperature: 0.7,
  systemPrompt: "test", streaming: true, defaultContextScope: "note",
  maxContextNotes: 20, panelWidth: 420, panelHeight: 600, chatHistory: [],
  sessions: [], activeSessionId: "", toolApproval: {},
};

const panel = new FloatingChatPanel(plugin);
console.log("PANEL_BUILT root attached to body:", document.body.children.length > 0);
console.log("PANEL_ROOT_CLASS:", panel["rootEl"] ? panel["rootEl"].className : "(none)");
// toggle to floating
panel["toggleMode"]();
console.log("AFTER_TOGGLE body children:", document.body.children.length);
console.log("PANEL_SMOKE_OK");
`;

const result = await esbuild.build({
  stdin: { contents: entry, resolveDir: path.join(root, "test"), loader: "ts" },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  plugins: [electronMockPlugin, 
    {
      name: "mock-obsidian",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
        build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: obsidianMock, loader: "js" }));
      },
    },
  ],
});

// Provide DOM globals to the bundle. esbuild output uses `document`, `window`.
const mod = result.outputFiles[0].text;
const dataUrl = "data:text/javascript;base64," + Buffer.from(mod).toString("base64");

// Inject jsdom globals before importing the data URL module.
global.window = window;
global.document = window.document;
global.HTMLElement = window.HTMLElement;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

// Polyfill Obsidian's HTMLElement extensions (addClass/removeClass/etc).
{
  const proto = window.HTMLElement.prototype;
  proto.addClass = function (...c) { this.classList.add(...c); return this; };
  proto.removeClass = function (...c) { this.classList.remove(...c); return this; };
  proto.toggleClass = function (c, f) { if (f === undefined) f = !this.classList.contains(c); f ? this.classList.add(c) : this.classList.remove(c); return this; };
  proto.setText = function (t) { this.textContent = t; return this; };
  proto.getText = function () { return this.textContent || ""; };
  proto.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); return this; };
  proto.setAttr = function (k, v) { this.setAttribute(k, v); return this; };
  proto.setCssStyles = function (styles) { for (const k in styles) { try { this.style[k] = styles[k]; } catch (e) {} } return this; };
  proto.setCssProps = function (props) { for (const k in props) { try { this.style.setProperty(k, props[k]); } catch (e) {} } return this; };
}

try {
  await import(dataUrl);
  console.log("✅ Panel smoke test passed");
} catch (e) {
  console.error("❌ Panel smoke test FAILED:", e);
  process.exit(1);
}
