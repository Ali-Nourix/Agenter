import { electronMockPlugin } from "./esbuild-electron-mock.mjs";
/**
 * Verifies the contextual (selection) popover: that it mounts, that placement
 * honours the user's choice — caret-following vs. a pinned spot — and that
 * dragging it pins that spot for next time.
 */
import * as esbuild from "esbuild";
import { JSDOM } from "jsdom";
import path from "path";

const root = path.resolve(".");

const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {
  url: "app://obsidian.md",
  pretendToBeVisual: true,
});
const { window } = dom;

const obsidianMock = `
export class TFile { constructor(p){ this.path=p; } }
export class TFolder { constructor(p){ this.path=p; this.children=[]; } }
export class Notice { constructor(m){ console.log('[Notice]', m); } }
export const requestUrl = async () => ({ status:200, text:"", json:()=>({}) });
export class Menu { addItem(){ return this; } addSeparator(){} showAtPosition(){} }
export class Modal { constructor(){} open(){} close(){} }
export class Plugin { constructor(){ this.app={}; this.settings={}; } }
export class WorkspaceLeaf {}
export class ItemView { constructor(leaf){ this.leaf=leaf; this.contentEl=document.createElement("div"); } }
export class Setting { constructor(){} setName(){return this;} setDesc(){return this;} setHeading(){return this;} addText(){return this;} addDropdown(){return this;} addToggle(){return this;} addButton(){return this;} addTextArea(){return this;} addSlider(){return this;} }
export class PluginSettingTab { constructor(){} display(){} }
export const setIcon = (el, icon) => { el.setAttribute("data-icon", icon); };
export class Component { load(){} unload(){ this.unloaded = true; } registerEvent(){} }
export class MarkdownRenderer {
  static render(app, text, el) { return Promise.resolve().then(() => { el.textContent = text; }); }
}
export class MarkdownView {}
export class Editor {}
`;

const entry = `
import { SelectionPopover, openSelectionPopover } from "../src/selection-popover";
import AgenterPlugin from "../main";

const plugin = new AgenterPlugin();
plugin.app = {
  workspace: {
    getActiveFile: () => ({ path: "Note.md" }),
    getActiveViewOfType: () => null,
  },
  vault: {
    getAbstractFileByPath: () => null,
    getFileByPath: () => null,
    getFolderByPath: () => null,
    read: async () => "",
    cachedRead: async () => "",
    getMarkdownFiles: () => [],
  },
};
const saved = [];
plugin.saveSettings = async () => { saved.push(JSON.parse(JSON.stringify(plugin.settings.contextualPinned))); };
plugin.settings = {
  providers: [{ id:"p1", name:"OpenAI", type:"openai", baseUrl:"https://api.openai.com/v1", apiKey:"x", model:"gpt-4o", extraHeaders:"", supportsWebSearch:false, supportsVision:false }],
  activeProviderId: "p1",
  maxTokens: 4096, temperature: 0.7, systemPrompt: "test", streaming: true,
  defaultContextScope: "note", maxContextNotes: 20, panelWidth: 420, panelHeight: 600,
  chatHistory: [], sessions: [], activeSessionId: "", toolApproval: {}, customPrompts: {},
  contextualAutoShow: true, contextualAnchor: "selection", contextualPinned: null,
};

const readPlacement = (el) => ({
  left: el.style.getPropertyValue("--agenter-ctx-left"),
  top: el.style.getPropertyValue("--agenter-ctx-top"),
});

// 1) Follows the caret when that is what the user asked for.
let popover = openSelectionPopover(plugin, "hello world from the vault", { x: 300, y: 220 });
let el = document.querySelector(".agenter-ctx");
if (!el) throw new Error("popover did not mount");
const following = readPlacement(el);
if (following.left !== "308px" || following.top !== "228px") {
  throw new Error("caret placement wrong: " + JSON.stringify(following));
}

// 2) A pinned popover ignores the caret entirely.
plugin.settings.contextualAnchor = "pinned";
plugin.settings.contextualPinned = { x: 640, y: 480 };
popover.close();
if (document.querySelector(".agenter-ctx")) throw new Error("close left the popover mounted");
popover = openSelectionPopover(plugin, "hello world from the vault", { x: 12, y: 14 });
el = document.querySelector(".agenter-ctx");
const pinned = readPlacement(el);
if (pinned.left !== "640px" || pinned.top !== "480px") {
  throw new Error("pinned placement wrong: " + JSON.stringify(pinned));
}

// 3) Dragging the header records the new spot and switches to pinned mode.
plugin.settings.contextualAnchor = "selection";
plugin.settings.contextualPinned = null;
popover.close();
popover = openSelectionPopover(plugin, "hello world from the vault", { x: 100, y: 100 });
el = document.querySelector(".agenter-ctx");
const head = el.querySelector(".agenter-ctx-head");
const fire = (target, type, init) => target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, ...init }));
fire(head, "mousedown", { button: 0, clientX: 110, clientY: 105 });
fire(document, "mousemove", { clientX: 420, clientY: 330 });
fire(document, "mouseup", {});
if (plugin.settings.contextualAnchor !== "pinned") throw new Error("drag did not pin the popover");
if (!saved.length) throw new Error("drag did not persist the pinned spot");

// 4) Only one contextual popover is ever on screen.
openSelectionPopover(plugin, "another selection");
if (document.querySelectorAll(".agenter-ctx").length !== 1) {
  throw new Error("a second popover was left mounted");
}
SelectionPopover.closeCurrent();
if (SelectionPopover.isOpen()) throw new Error("closeCurrent did not clear the popover");

// 5) An empty selection is refused rather than showing an empty card.
if (openSelectionPopover(plugin, "   ") !== null) throw new Error("blank selection opened a popover");

console.log("CONTEXTUAL_POPOVER_OK");
`;

const result = await esbuild.build({
  stdin: { contents: entry, resolveDir: path.join(root, "test"), loader: "ts" },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  plugins: [
    electronMockPlugin,
    {
      name: "mock-obsidian",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
        build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: obsidianMock, loader: "js" }));
      },
    },
  ],
});

const dataUrl =
  "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64");

global.window = window;
global.document = window.document;
global.HTMLElement = window.HTMLElement;
global.MouseEvent = window.MouseEvent;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

// Obsidian's DOM helpers, as used by the popover.
{
  const proto = window.HTMLElement.prototype;
  proto.addClass = function (...c) { this.classList.add(...c); return this; };
  proto.removeClass = function (...c) { this.classList.remove(...c); return this; };
  proto.hasClass = function (c) { return this.classList.contains(c); };
  proto.toggleClass = function (c, f) { if (f === undefined) f = !this.classList.contains(c); f ? this.classList.add(c) : this.classList.remove(c); return this; };
  proto.setText = function (t) { this.textContent = t; return this; };
  proto.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); return this; };
  proto.setAttr = function (k, v) { this.setAttribute(k, v); return this; };
  proto.setCssStyles = function (s) { for (const k in s) { try { this.style[k] = s[k]; } catch {} } return this; };
  proto.setCssProps = function (p) { for (const k in p) { try { this.style.setProperty(k, p[k]); } catch {} } return this; };

  const make = (parent, tag, o = {}) => {
    const el = window.document.createElement(o.tag ?? tag);
    if (o.cls) el.className = o.cls;
    if (o.text) el.textContent = o.text;
    if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, String(v));
    parent.appendChild(el);
    return el;
  };
  proto.createEl = function (tag, o) { return make(this, tag, o); };
  proto.createDiv = function (o) { return make(this, "div", o); };
  proto.createSpan = function (o) { return make(this, "span", o); };
  global.createDiv = (o) => make(window.document.createDocumentFragment(), "div", o);
  global.createEl = (tag, o) => make(window.document.createDocumentFragment(), tag, o);
  global.createSpan = (o) => make(window.document.createDocumentFragment(), "span", o);
}

try {
  await import(dataUrl);
  console.log("✅ Contextual popover test passed");
} catch (e) {
  console.error("❌ Contextual popover test FAILED:", e);
  process.exit(1);
}
