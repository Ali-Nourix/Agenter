// Shared by the harness tests: bundles a TypeScript entry point of the plugin for Node, with Obsidian and Electron
// replaced by small stand-ins, and returns its exports.
import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const OBSIDIAN_MOCK = `
export const requestUrl = async (opts) => { if (globalThis.__requestUrl) return globalThis.__requestUrl(opts); throw new Error("unexpected requestUrl"); };
export class TFile { constructor(p) { this.path = p; this.name = String(p).split("/").pop(); this.extension = String(p).split(".").pop(); this.parent = { path: String(p).split("/").slice(0, -1).join("/") }; } }
export class TFolder { constructor(p) { this.path = p; this.children = []; } }
export class Notice { constructor(m) { (globalThis.__notices ||= []).push(String(m)); } }
export class Menu { addItem(cb) { const it = { setTitle() { return it; }, setChecked() { return it; }, onClick() { return it; }, setIcon() { return it; } }; cb(it); return this; } addSeparator() {} showAtPosition() {} showAtMouseEvent() {} }
export class Modal { constructor() {} open() {} close() {} }
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class ItemView {}
export class WorkspaceLeaf {}
export class Component { load() {} unload() {} }
export class MarkdownView {}
export const MarkdownRenderer = { render: async (_app, text, el) => { el.textContent = text; } };
export const setIcon = (el, icon) => { el.textContent = icon; };
export const loadPdfJs = async () => { if (globalThis.__pdfjs) return globalThis.__pdfjs; throw new Error("no pdf.js"); };
export const Platform = { isDesktop: true, isMobile: false };
export const normalizePath = (p) => p;
`;

const mockPlugin = {
  name: "mock-obsidian",
  setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock-obsidian" }));
    b.onLoad({ filter: /.*/, namespace: "mock-obsidian" }, () => ({ contents: OBSIDIAN_MOCK, loader: "js" }));
    b.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "mock-electron" }));
    b.onLoad({ filter: /.*/, namespace: "mock-electron" }, () => ({ contents: "export const shell = { openExternal: async () => undefined };", loader: "js" }));
  },
};

export async function load(entry) {
  const result = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
    plugins: [mockPlugin],
  });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));
}

let checked = 0;
export function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}\n  got      ${a}\n  expected ${e}`);
  checked++;
}
export function ok(value, label) {
  if (!value) throw new Error(`${label}: expected a truthy value, got ${JSON.stringify(value)}`);
  checked++;
}
export function near(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance) throw new Error(`${label}\n  got      ${actual}\n  expected ${expected} ± ${tolerance}`);
  checked++;
}
export const count = () => checked;
