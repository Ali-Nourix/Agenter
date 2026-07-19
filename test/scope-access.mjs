import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(fileURLToPath(import.meta.url));
const obsidianMock = `
var TFile = class { constructor(p){ this.path=p; this.extension=p.split('.').pop(); this.basename=p.split('/').pop().replace(/\\.md$/,''); this.name=p.split('/').pop(); this.stat={size:1,ctime:0,mtime:0}; } };
var TFolder = class { constructor(p){ this.path=p; this.name=p.split('/').pop()||''; this.children=[]; } };
var requestUrl = async () => ({status:200,text:'',json:()=>({})});
export { TFile, TFolder, requestUrl };
`;

const entry = `
import { ToolRegistry } from "../src/tools";
import { TFile, TFolder } from "obsidian";
const root=new TFolder(""), folder=new TFolder("Folder"), sub=new TFolder("Folder/Sub"), other=new TFolder("Other"), backups=new TFolder(".agenter-backups");
const allowed=new TFile("Allowed.md"), secret=new TFile("Secret.md"), a=new TFile("Folder/A.md"), b=new TFile("Folder/Sub/B.md"), c=new TFile("Other/C.md");
root.children.push(allowed,secret,folder,other,backups); folder.children.push(a,sub); sub.children.push(b); other.children.push(c);
const nodes=new Map([["",root],["Folder",folder],["Folder/Sub",sub],["Other",other],[".agenter-backups",backups],...[allowed,secret,a,b,c].map(x=>[x.path,x])]);
const contents=new Map([[allowed.path,"allowed needle"],[secret.path,"secret needle"],[a.path,"folder needle"],[b.path,"nested needle"],[c.path,"outside needle"]]);
const app={vault:{getRoot(){return root},getMarkdownFiles(){return [allowed,secret,a,b,c]},getFiles(){return [allowed,secret,a,b,c]},getAbstractFileByPath(p){return nodes.get(p)??null},async read(f){return contents.get(f.path)??""},async cachedRead(f){return contents.get(f.path)??""},async modify(f,t){contents.set(f.path,t)},async create(p,t){contents.set(p,t);const f=new TFile(p);nodes.set(p,f);return f},async createFolder(p){const f=new TFolder(p);nodes.set(p,f);return f}},workspace:{getActiveFile(){return secret}},metadataCache:{getFileCache(){return{}},resolvedLinks:{},unresolvedLinks:{}},fileManager:{}};
const registry=new ToolRegistry(app);
const call=(id,name,args={})=>registry.execute({id,name,arguments:JSON.stringify(args)});
const access=(id,name,args={})=>registry.getAccessRequest({id,name,arguments:JSON.stringify(args)});

registry.setAccessScope({mode:"note",notePath:"Allowed.md",folderPath:""});
const names=registry.getDefinitions().map(x=>x.name);
if(!names.includes("read_note")||!names.includes("search_notes")||!names.includes("list_folders")) throw new Error("wider tools must remain visible for permission requests");
let result=await call("r1","read_note",{path:"Allowed.md"});
if(result.output!=="allowed needle") throw new Error("allowed note failed");
result=await call("r2","read_note",{path:"Secret.md"});
if(!/Tool error: Access denied/.test(result.output)) throw new Error("unapproved cross-note read was not blocked");
let request=access("r2","read_note",{path:"Secret.md"});
if(!request||request.requestedMode!=="note"||request.targetPath!=="Secret.md") throw new Error("note access request mismatch: "+JSON.stringify(request));
registry.grantAccess(request);
result=await call("r2","read_note",{path:"Secret.md"});
if(result.output!=="secret needle"||access("r3","read_note",{path:"Secret.md"})!==null) throw new Error("approved note did not resume/stay granted");

registry.setAccessScope({mode:"folder",notePath:"Folder/A.md",folderPath:"Folder"});
result=await call("l1","list_notes",{folder:"Folder",limit:20});
if(!/Folder\\/A\\.md/.test(result.output)||!/Folder\\/Sub\\/B\\.md/.test(result.output)||/Other\\/C/.test(result.output)) throw new Error("folder scope leaked: "+result.output);
request=access("s1","search_notes",{query:"needle",limit:20});
if(!request||request.requestedMode!=="vault") throw new Error("vault request missing: "+JSON.stringify(request));
result=await call("s1","search_notes",{query:"needle",limit:20});
if(!/Tool error: Access denied/.test(result.output)) throw new Error("unapproved vault search ran");
registry.grantAccess(request);
result=await call("s1","search_notes",{query:"needle",limit:20});
if(!/Allowed\.md/.test(result.output)||!/Other\\/C\.md/.test(result.output)) throw new Error("approved vault search did not expand: "+result.output);

registry.setAccessScope({mode:"none",notePath:"Allowed.md"});
result=await call("n1","read_note",{path:"Allowed.md"});
if(!/Tool error: Access denied/.test(result.output)) throw new Error("none scope ran without approval");
request=access("n1","read_note",{path:"Allowed.md"});
if(!request||request.requestedMode!=="note") throw new Error("none->note request missing");
registry.grantAccess(request);
result=await call("n1","read_note",{path:"Allowed.md"});
if(result.output!=="allowed needle") throw new Error("none->note approval failed");

console.log("SCOPE_ACCESS_RESUME_OK");
`;
const result=await build({stdin:{contents:entry,resolveDir:root,loader:"ts"},bundle:true,format:"esm",platform:"node",write:false,plugins:[{name:"mock-obsidian",setup(b){b.onResolve({filter:/^obsidian$/},()=>({path:"obsidian",namespace:"mock"}));b.onLoad({filter:/.*/,namespace:"mock"},()=>({contents:obsidianMock,loader:"js"}))}}]});
await import("data:text/javascript;base64,"+Buffer.from(result.outputFiles[0].text).toString("base64"));
