import { electronMockPlugin } from "./esbuild-electron-mock.mjs";
// run-test.mjs — bundles test/smoke.ts with a mocked "obsidian" module
// and runs it under Node, so we can verify tool logic without Obsidian.
import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import path from "path";
import { promises as fs } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const mockObsidian = `
export class TFile { constructor(p){ this.path=p; const i=p.lastIndexOf('/'); this.parent={path: i>=0?p.slice(0,i):''}; this.name=p.slice(i+1); } }
export class TFolder { constructor(p){ this.path=p; this.children=[]; } }
export class Notice { constructor(m){ console.log('[Notice]', m); } }
export const requestUrl = async (opts) => {
  const url = (opts && opts.url) || "";
  if (url.endsWith("/models") || url.includes("/models?")) {
    return {
      status: 200,
      text: JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "gpt-3.5-turbo" }] }),
      json: function () {
        return { data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "gpt-3.5-turbo" }] };
      },
    };
  }
  return { status: 200, text: "", json: () => ({}) };
};
export class Menu { addItem(cb){ return this; } addSeparator(){} showAtPosition(){} }
export class Modal { constructor(){} open(){} close(){} onOpen(){} onClose(){} get contentEl(){ return document.createElement('div'); } }
export class PluginSettingTab { constructor(){} display(){} }
export class Setting { constructor(){} setName(){return this;} setDesc(){return this;} addText(){return this;} addDropdown(){return this;} addToggle(){return this;} addButton(){return this;} addTextArea(){return this;} }
export const addIcon = ()=>{};
`;

const result = await esbuild.build({
  entryPoints: [path.join(root, "test/smoke.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  plugins: [electronMockPlugin, 
    {
      name: "mock-obsidian",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({
          path: "obsidian",
          namespace: "mock-obsidian",
        }));
        build.onLoad({ filter: /.*/, namespace: "mock-obsidian" }, () => ({
          contents: mockObsidian,
          loader: "js",
        }));
      },
    },
  ],
});

const code = result.outputFiles[0].text;
const dataUrl = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
await import(dataUrl);
