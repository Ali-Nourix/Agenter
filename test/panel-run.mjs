// panel-run.mjs — run the built main.js inside a minimal DOM mock to
// confirm FloatingChatPanel builds and appends to the document without
// throwing (catches the "panel doesn't open" class of bugs).
import { JSDOM } from "jsdom";
import vm from "vm";
import fs from "fs";

const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {
  url: "app://obsidian.md",
  pretendToBeVisual: true,
});
const { window } = dom;
global.window = window;
global.document = window.document;
global.HTMLElement = window.HTMLElement;
global.navigator = window.navigator;

// Minimal Obsidian API mock.
const ObsidianMock = `
window.requestUrl = async (opts) => {
  const url = (opts && opts.url) || "";
  if (url.endsWith("/models")) return { status: 200, text: JSON.stringify({ data: [{ id: "gpt-4o" }] }), json: () => ({ data: [{ id: "gpt-4o" }] }) };
  return { status: 200, text: "", json: () => ({}) };
};
window.Notice = class { constructor(m){ console.log("[Notice]", m); } };
window.Menu = class { addItem(cb){ const it={setTitle(){return it;},setChecked(){return it;},onClick(){return it;}}; cb(it); return this; } addSeparator(){} showAtPosition(){} };
window.Modal = class { constructor(){} open(){} close(){} onOpen(){} onClose(){} get contentEl(){ return document.createElement('div'); } };
window.PluginSettingTab = class { constructor(){} display(){} };
window.Setting = class { constructor(){} setName(){return this;} setDesc(){return this;} addText(){return this;} addDropdown(){return this;} addToggle(){return this;} addButton(){return this;} addTextArea(){return this;} };
window.MarkdownView = class {};
window.TFile = class { constructor(p){ this.path=p; const i=p.lastIndexOf('/'); this.parent={path:i>=0?p.slice(0,i):''}; this.name=p.slice(i+1); } };
window.TFolder = class { constructor(p){ this.path=p; this.children=[]; } };
window.addIcon = () => {};
`;

const code = fs.readFileSync("./main.js", "utf8");

try {
  const context = vm.createContext({
    window,
    document: window.document,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
  });
  vm.runInContext(ObsidianMock, context);
  vm.runInContext(code, context);
  console.log("main.js executed without throwing ✅");
  console.log("body children after load:", window.document.body.children.length);
} catch (e) {
  console.error("❌ main.js threw:", e);
  process.exit(1);
}
