// The panel as a person meets it: the bar that says how full the window is, copying and selecting text, the
// right-click menu, notices for what the harness did, attachments. Driven in jsdom against a scripted server.
import { electronMockPlugin } from "./esbuild-electron-mock.mjs";
import { build } from "esbuild";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";
import { eq, ok, count } from "./harness-helpers.mjs";

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
  proto.setCssStyles = function (styles) { for (const k in styles) { try { this.style[k] = styles[k]; } catch (e) {} } };
  proto.setCssProps = function (props) { for (const k in props) { try { this.style.setProperty(k, props[k]); } catch (e) {} } };
  proto.createEl = function (tag, o) { const el = document.createElement(tag); if (o) { if (o.cls) { const cls = Array.isArray(o.cls) ? o.cls : [o.cls]; el.classList.add(...cls); } if (o.text != null) el.textContent = o.text; if (o.type) el.setAttribute('type', o.type); if (o.href != null) el.setAttribute('href', o.href); if (o.title != null) el.setAttribute('title', o.title); if (o.placeholder != null) el.setAttribute('placeholder', o.placeholder); if (o.value != null) el.value = o.value; if (o.attr) { for (const k in o.attr) el.setAttribute(k, o.attr[k]); } } this.appendChild(el); return el; };
  proto.createDiv = function (o) { return this.createEl('div', typeof o === 'string' ? { cls: o } : o); };
  proto.createSpan = function (o) { return this.createEl('span', typeof o === 'string' ? { cls: o } : o); };
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
  constructor(){ this.items = []; (globalThis.__menus ||= []).push(this); }
  addItem(cb){ const it={ title:"", setTitle(t){ it.title=t; return it;}, setChecked(){return it;}, setIcon(){return it;}, onClick(f){ it.click=f; return it;} }; cb(it); this.items.push(it); return this; }
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



// ── a scripted server ─────────────────────────────────────────────────────
const queue = [];
const seen = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push(JSON.parse(body || "{}"));
    const handler = queue.shift();
    if (!handler) { res.writeHead(500); return res.end("exhausted"); }
    handler(res);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
const say = (text, usage) => (res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  if (usage) res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
};
const fail = (status) => (res) => { res.writeHead(status, { "Retry-After": "0" }); res.end("{}"); };

const clipboard = [];
Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText: async (t) => { clipboard.push(t); } }, configurable: true });

const entry = `
import AgenterPlugin from "../main";
import { FloatingChatPanel } from "../src/ui";
import { DEFAULT_SETTINGS } from "../src/settings";
export { AgenterPlugin, FloatingChatPanel, DEFAULT_SETTINGS };
`;
const result = await build({
  stdin: { contents: entry, resolveDir: path.join(root), loader: "ts" },
  bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent",
  plugins: [electronMockPlugin, {
    name: "mock-obsidian",
    setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
      b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: obsidianMock, loader: "js" }));
    },
  }],
});
const { AgenterPlugin, FloatingChatPanel, DEFAULT_SETTINGS } = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));

const plugin = new AgenterPlugin();
plugin.app = {
  workspace: { getActiveFile: () => ({ path: "Note.md", parent: { path: "" } }), getActiveViewOfType: () => null },
  vault: { getAbstractFileByPath: () => null, getFileByPath: () => null, getFolderByPath: () => null, read: async () => "", cachedRead: async () => "", create: async () => {}, modify: async () => {}, process: async (f, fn) => fn("") },
  setting: { open() {}, openTabById() {} },
};
plugin.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
const provider = plugin.settings.providers.find((p) => p.id === "openai-compatible-default");
Object.assign(provider, { baseUrl: url, apiKey: "k", model: "test-model", supportsVision: true });
plugin.settings.activeProviderId = provider.id;
plugin.saveSettings = async () => {};
plugin.harnessReport = () => "REPORT";

const panel = new FloatingChatPanel(plugin);
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const send = async (text) => { panel["inputEl"].value = text; await panel["send"](); await wait(30); };

// ── the bar ───────────────────────────────────────────────────────────────
{
  const meter = $(".agenter-ctxmeter-btn");
  ok(meter, "the panel has a context bar");
  eq(meter.getAttribute("role"), "meter", "…that is a meter for assistive technology");
  ok(/Context window \d+% full/.test(meter.getAttribute("aria-valuetext")), "…with a sentence for a label");
  ok(/%/.test($(".agenter-ctxmeter-label").textContent) && $(".agenter-ctxmeter-label").textContent.startsWith("≈"), "an estimate says it is one");
  ok($(".agenter-ctxmeter").classList.contains("is-estimated") && $(".agenter-ctxmeter").classList.contains("is-ok"), "and starts in the calm colour");
  const before = Number($(".agenter-ctxmeter-btn").getAttribute("aria-valuenow"));
  panel["inputEl"].value = "word ".repeat(30000);
  panel["inputEl"].dispatchEvent(new window.Event("input"));
  await wait(300);
  const after = Number($(".agenter-ctxmeter-btn").getAttribute("aria-valuenow"));
  ok(after > before, `typing a long message moves the bar (${before}% → ${after}%)`);
  panel["inputEl"].value = "";
  panel["inputEl"].dispatchEvent(new window.Event("input"));
  await wait(300);
  eq(Number($(".agenter-ctxmeter-btn").getAttribute("aria-valuenow")), before, "and clearing it moves it back");

  // A run that reports its size.
  queue.push(say("Hello there!", { prompt_tokens: 12000, completion_tokens: 40 }));
  await send("hi");
  ok(!$(".agenter-ctxmeter").classList.contains("is-estimated"), "after an answer the bar shows the provider's own count");
  ok($(".agenter-ctxmeter-btn").getAttribute("aria-valuetext").includes("12,040"), "…the request plus the answer: 12,040 tokens");
  ok($(".agenter-ctxmeter-label").textContent.includes("12k"), "…and says so in short");
  ok(!$(".agenter-ctxmeter-label").textContent.startsWith("≈"), "…without the approximation sign");
  eq(seen[0].max_tokens, 32768, "the request carried no cap of ours");
}

// ── the details ───────────────────────────────────────────────────────────
{
  $(".agenter-ctxmeter-btn").click();
  const pop = $(".agenter-ctxmeter-pop");
  ok(pop, "a click opens the details");
  eq($(".agenter-ctxmeter-btn").getAttribute("aria-expanded"), "true", "…and says so");
  eq($$(".agenter-ctxmeter-part", pop).map((li) => li.querySelector(".agenter-ctxmeter-part-name").textContent), ["Instructions", "Tools", "Conversation"], "it breaks the window into what it holds");
  ok(/Compaction/.test(pop.textContent) && /Next answer may be up to/.test(pop.textContent), "and says when compaction starts and how long the next answer can be");
  const compact = $$(".agenter-ctxmeter-action", pop).find((b) => b.textContent === "Compact now");
  ok(compact && !compact.disabled, "Compact now is offered");
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok(!$(".agenter-ctxmeter-pop"), "Escape closes it");
}

// ── copying and selecting ─────────────────────────────────────────────────
{
  const assistant = $$(".agenter-msg-assistant")[0];
  const user = $$(".agenter-msg-user")[0];
  ok($(".agenter-msg-copy", assistant) && $(".agenter-msg-copy", user), "every message has a copy button");
  eq($(".agenter-msg-copy", assistant).getAttribute("aria-label"), "Copy message", "it has a name");
  $(".agenter-msg-copy", assistant).click();
  await wait(20);
  eq(clipboard.at(-1), "Hello there!", "it copies the message as written");
  ok($(".agenter-msg-copy", assistant).classList.contains("is-copied"), "and shows that it did");
  eq($(".agenter-msg-copy", assistant).getAttribute("aria-label"), "Copied", "…to a screen reader too");
  $(".agenter-msg-copy", user).click();
  await wait(20);
  eq(clipboard.at(-1), "hi", "the user's message too");

  globalThis.__menus = [];
  const bubble = $(".agenter-bubble", assistant);
  const event = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  bubble.dispatchEvent(event);
  ok(event.defaultPrevented, "a right click on a message opens Agenter's menu in place of the system's");
  const menu = globalThis.__menus.at(-1);
  eq(menu.items.map((i) => i.title), ["Copy message (Markdown)", "Copy message (plain text)", "Select message text", "Copy whole conversation"], "with the ways to copy");
  menu.items[0].click();
  await wait(20);
  eq(clipboard.at(-1), "Hello there!", "Copy message (Markdown)");
  menu.items[3].click();
  await wait(20);
  ok(clipboard.at(-1).startsWith("# ") && clipboard.at(-1).includes("## You\n\nhi") && clipboard.at(-1).includes("## Agenter\n\nHello there!"), "Copy whole conversation is Markdown with both sides");
  const button = $(".agenter-controls button[aria-label='Copy conversation as Markdown']");
  ok(button, "and there is a button for it in the header");
  button.click();
  await wait(20);
  ok(clipboard.at(-1).includes("## Agenter"), "which does the same");
  const onButton = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  $(".agenter-msg-copy", assistant).dispatchEvent(onButton);
  ok(!onButton.defaultPrevented, "a right click on a button is left alone");
}

// ── what the harness did, shown ───────────────────────────────────────────
{
  queue.push(fail(503));
  queue.push(say("After a pause."));
  await send("again");
  const notice = $(".agenter-notice.is-retry");
  ok(notice && /Trying again/.test(notice.textContent), "a retry is written in the chat");
  eq($(".agenter-notice.is-retry").getAttribute("role"), "status", "…as a status for a screen reader");
  eq($$(".agenter-msg-assistant").at(-1).dataset.raw, "After a pause.", "and the answer arrives");
  eq($$(".agenter-notice.is-retry").length, 1, "one line, however many waits");
}

// ── attachments ───────────────────────────────────────────────────────────
{
  const png = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(100, 16); png.writeUInt32BE(100, 20);
  const file = (name, type, data) => ({ name, type, size: data.length, arrayBuffer: async () => data });
  await panel["addAttachments"]([file("pic.png", "image/png", png), file("notes.docx", "", Buffer.from("PK")), file("report.pdf", "application/pdf", Buffer.from("%PDF-1.4")), file("tool.exe", "application/octet-stream", Buffer.from("MZ"))]);
  const chips = $$(".agenter-attachment-chip");
  eq(chips.length, 3, "three files are attached; the one that cannot be read is refused");
  ok(chips[0].classList.contains("is-native") && /will see this image/.test(chips[0].title), "a picture for a model that can see: it will see it");
  ok(chips[1].classList.contains("is-text"), "a Word file is read as text");
  ok(chips[2].classList.contains("is-text") || chips[2].classList.contains("is-native"), "a PDF is read or sent");
  provider.supportsVision = false; provider.model = "plain-model";
  panel["refreshProviderLabel"]();
  const blind = $$(".agenter-attachment-chip")[0];
  ok(blind.classList.contains("is-listed") && /only be told it was attached/.test(blind.title), "for a model that cannot see and has no helper, the chip says what the model will be told");
  ok($(".agenter-attachment-plan", blind).textContent === "cannot see", "…in a word");
  $(".agenter-attachment-chip button").click();
  eq($$(".agenter-attachment-chip").length, 2, "a chip can be removed");
  provider.supportsVision = true; provider.model = "test-model";
  panel["pendingParts"] = []; panel["renderPendingAttachments"]();
}

// ── a window too small: compaction is announced ───────────────────────────
{
  plugin.settings.modelOverrides["openai-compatible-default:test-model"] = { contextWindow: 8000, maxOutput: 1000 };
  const filler = "lorem ".repeat(1500);
  panel["orchestrator"].setMessages([
    { role: "user", content: "q1 " + filler }, { role: "assistant", content: "a1 " + filler },
    { role: "user", content: "q2 " + filler }, { role: "assistant", content: "a2 " + filler },
  ]);
  panel["messages"] = panel["orchestrator"].messages;
  const responder = (res) => {
    const last = seen.at(-1);
    return /^You compress/.test(last.messages[0].content) ? say("A short summary.")(res) : say("Done.")(res);
  };
  for (let i = 0; i < 6; i++) queue.push(responder);
  await send("what now?");
  ok($(".agenter-notice.is-compact") && /Context compacted/.test($(".agenter-notice.is-compact").textContent), "a compaction is announced in the chat");
  eq($$(".agenter-msg-assistant").at(-1).dataset.raw, "Done.", "and the conversation goes on");
}

server.close();
console.log(`HARNESS_UI_OK (${count()} checks)`);
