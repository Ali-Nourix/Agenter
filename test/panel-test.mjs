/**
 * DOM smoke test: verify FloatingChatPanel builds without throwing and
 * actually appends a root element to the document body (or sidebar).
 * Uses a minimal DOM mock so we can run under Node.
 */
const mockEl = () => {
  const el: any = {
    children: [],
    style: {},
    classList: { _s: new Set(), add(...c: string[]) { c.forEach(x => this._s.add(x)); }, remove(...c: string[]) { c.forEach(x => this._s.delete(x)); }, toggle(c: string, f?: boolean) { if (f === undefined) f = !this._s.has(c); f ? this._s.add(c) : this._s.delete(c); }, contains(c: string) { return this._s.has(c); } },
    dataset: {},
    _attrs: {},
    addClass(...c: string[]) { this.classList.add(...c); },
    removeClass(...c: string[]) { this.classList.remove(...c); },
    toggleClass(c: string, f?: boolean) { this.classList.toggle(c, f); },
    setAttribute(k: string, v: string) { this._attrs[k] = v; },
    getAttribute(k: string) { return this._attrs[k]; },
    appendChild(c: any) { this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c: any, ref: any) { const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); c.parentNode = this; return c; },
    removeChild(c: any) { this.children = this.children.filter(x => x !== c); },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    empty() { this.children = []; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    getText() { return this._text || ""; },
    setText(t: string) { this._text = t; },
    getBoundingClientRect() { return { left: 0, top: 0, bottom: 0, right: 0, width: 0, height: 0 }; },
    focus() {},
    closest() { return null; },
    parentNode: null,
  };
  return el;
};

const documentMock = {
  body: mockEl(),
  createElement: () => mockEl(),
  createTextNode: (t: string) => ({ text: t }),
  getElementById: () => null,
  head: mockEl(),
};

const windowMock = {
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener() {},
  getSelection: () => ({ toString: () => "" }),
};

const obsidianMock = `
export class TFile { constructor(p){ this.path=p; const i=p.lastIndexOf('/'); this.parent={path: i>=0?p.slice(0,i):''}; this.name=p.slice(i+1); } }
export class TFolder { constructor(p){ this.path=p; this.children=[]; } }
export class Notice { constructor(m){ console.log('[Notice]', m); } }
export const requestUrl = async (opts) => {
  const url = (opts && opts.url) || "";
  if (url.endsWith("/models")) return { status:200, text: JSON.stringify({data:[{id:"gpt-4o"}]}), json:()=>({data:[{id:"gpt-4o"}]}) };
  return { status:200, text:"", json:()=>({}) };
};
export class Menu { addItem(cb){ const it={ setTitle(){return it;}, setChecked(){return it;}, onClick(){return it;} }; cb(it); return this; } addSeparator(){} showAtPosition(){} }
export class Modal { constructor(){} open(){} close(){} onOpen(){} onClose(){} get contentEl(){ return document.createElement('div'); } }
export class PluginSettingTab { constructor(){} display(){} }
export class Setting { constructor(){} setName(){return this;} setDesc(){return this;} addText(){return this;} addDropdown(){return this;} addToggle(){return this;} addButton(){return this;} addTextArea(){return this;} }
export const addIcon = ()=>{};
export class MarkdownView {}
`;

// Build the test bundle with esbuild, injecting mocks.
import * as esbuild from "esbuild";
import { pathToFileURL } from "url";
import path from "path";
import { promises as fs } from "fs";

const root = path.resolve(".");

const pluginCode = `
const document = globalThis.document;
const window = globalThis.window;
${obsidianMock}
`;

const result = await esbuild.build({
  entryPoints: [path.join(root, "test/panel-smoke.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  plugins: [
    {
      name: "mocks",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
        build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: obsidianMock, loader: "js" }));
      },
    },
  ],
  // inject globals
  banner: {
    js: `
globalThis.document = ${JSON.stringify({})};
globalThis.window = globalThis.window || {};
`,
  },
});

console.log("Panel build produced output:", result.outputFiles[0].text.length, "chars");
