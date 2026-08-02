import { electronMockPlugin } from "./esbuild-electron-mock.mjs";
import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(fileURLToPath(import.meta.url));
const obsidianMock = `
var TFile = class { constructor(p){ this.path=p; this.extension=p.split('.').pop(); this.basename=p.split('/').pop().replace(/\\.md$/,''); this.stat={size:1,ctime:0,mtime:0}; } };
var TFolder = class { constructor(p){ this.path=p; this.children=[]; } };
var requestUrl = async () => ({status:200,text:'',json:()=>({})});
export { TFile, TFolder, requestUrl };
`;

const entry = `
import { ToolRegistry } from "../src/tools";
import { TFile, TFolder } from "obsidian";

const folder = new TFolder("Existing");
const note = new TFile("Existing/Note.md");
const backupFolder = new TFolder(".agenter-backups");
let existingChecks = 0;
let backupChecks = 0;
let noteContent = "Before";
let modified = "";
const created = [];
const app = {
  vault: {
    getAbstractFileByPath(path) {
      if (path === "Existing") {
        existingChecks++;
        // Simulate stale Vault cache: initial checks miss the folder, then it appears.
        return existingChecks >= 3 ? folder : null;
      }
      if (path === "Existing/Note.md") return note;
      if (path === ".agenter-backups") {
        backupChecks++;
        // Reproduce the real bug: hidden backup folder exists, but first lookup is stale.
        return backupChecks >= 2 ? backupFolder : null;
      }
      return null;
    },
    async createFolder(path) { throw new Error("Folder already exists."); },
    async read(file) { return file.path === note.path ? noteContent : ""; },
    async create(path, content) { created.push([path, content]); },
    async modify(file, content) { modified = content; noteContent = content; },
  },
  workspace: { getActiveFile(){ return note; } },
  metadataCache: {},
  fileManager: {},
};
const registry = new ToolRegistry(app);
const folderResult = await registry.execute({ id:"folder", name:"create_folder", arguments: JSON.stringify({path:"Existing"}) });
if (/Tool error/i.test(folderResult.output)) throw new Error("create_folder still surfaced an error: " + folderResult.output);
const appendResult = await registry.execute({ id:"append", name:"append_note", arguments: JSON.stringify({path:"Existing/Note.md", content:"After"}) });
if (/Tool error/i.test(appendResult.output)) throw new Error("append_note failed: " + appendResult.output);
if (modified !== "Before\\nAfter") throw new Error("append content mismatch: " + modified);
if (!/Appended to Existing\\/Note\\.md/.test(appendResult.output)) throw new Error("append result mismatch: " + appendResult.output);
console.log("FOLDER_RACE_OK");
`;

const result = await build({
  stdin: { contents: entry, resolveDir: root, loader: "ts" },
  bundle: true, format: "esm", platform: "node", write: false,
  plugins: [electronMockPlugin, {
    name: "mock-obsidian",
    setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
      b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: obsidianMock, loader: "js" }));
    },
  }],
});
const dataUrl = "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64");
await import(dataUrl);
