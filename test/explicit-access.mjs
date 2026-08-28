import { electronMockPlugin } from "./esbuild-electron-mock.mjs";
import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";
const root=path.dirname(fileURLToPath(import.meta.url));
const obsidianMock=`
var TFile=class{constructor(p){this.path=p;this.extension='md';this.basename=p.split('/').pop().replace(/\\.md$/,'');this.name=p.split('/').pop();this.stat={size:1,ctime:0,mtime:0}}};
var TFolder=class{constructor(p){this.path=p;this.children=[]}};
var Notice=class{};var Modal=class{constructor(){}open(){}close(){}};var PluginSettingTab=class{constructor(){}};
var Setting=class{constructor(){}setName(){return this}setDesc(){return this}addText(){return this}addDropdown(){return this}addToggle(){return this}addButton(){return this}addTextArea(){return this}};
var requestUrl=async()=>({status:200,text:'',json:()=>({})});
export {TFile,TFolder,Notice,Modal,PluginSettingTab,Setting,requestUrl};
`;
const entry=`
import { AgentOrchestrator } from "../src/orchestrator";
import { OpenAIProvider } from "../src/api";
import { TFile,TFolder } from "obsidian";
const root=new TFolder(""),folder=new TFolder("Projects"),otherFolder=new TFolder("Private");
const current=new TFile("Current.md"),inside=new TFile("Projects/Plan.md"),outside=new TFile("Private/Secret.md");
root.children=[current,folder,otherFolder];folder.children=[inside];otherFolder.children=[outside];
const nodes=new Map([["",root],["Projects",folder],["Private",otherFolder],[current.path,current],[inside.path,inside],[outside.path,outside]]);
const app={vault:{getRoot(){return root},getMarkdownFiles(){return[current,inside,outside]},getFiles(){return[current,inside,outside]},getAbstractFileByPath(p){return nodes.get(p)??null},getFileByPath(p){const f=this.getAbstractFileByPath(p);return f&&f.extension!==undefined?f:null},getFolderByPath(p){const f=this.getAbstractFileByPath(p);return f&&f.children!==undefined?f:null},async process(f,fn){const next=fn(await this.read(f));if(this.modify)await this.modify(f,next);return next},async read(f){return f.path},async cachedRead(f){return f.path}},workspace:{getActiveFile(){return current}},metadataCache:{},fileManager:{}};
const settings={providers:[{id:"p",name:"OpenAI",type:"openai",baseUrl:"https://api.openai.com/v1",apiKey:"x",model:"gpt-4o",extraHeaders:"",supportsWebSearch:true,supportsVision:true}],activeProviderId:"p",maxTokens:1000,temperature:.2,systemPrompt:"test",toolApproval:{}};
let round=0;let protocolSeen=false;
OpenAIProvider.prototype.chat=async function(messages,tools,cb){
 round++;
 protocolSeen ||= messages[0].content.includes("never say you cannot request it") && tools.some(t=>t.name==="request_access");
 if(round===1) cb.onToolCalls([{id:"access-folder",name:"request_access",arguments:JSON.stringify({scope:"folder",path:"Projects",reason:"I need the project notes to answer."})}]);
 else if(round===2) cb.onToolCalls([{id:"list-folder",name:"list_notes",arguments:JSON.stringify({folder:"Projects",limit:20})}]);
 else {cb.onToken("Folder access worked and the run continued.");cb.onToolCalls([])}
 cb.onDone();
};
const orchestrator=new AgentOrchestrator(app,settings);orchestrator.setAccessScope({mode:"note",notePath:"Current.md",folderPath:""});
let accessRequests=0;const results=[];let answer="",done=0;const errors=[];
await orchestrator.run("دسترسی فولدر Projects را بگیر",{onAssistantToken:t=>answer+=t,onToolUse:()=>{},onToolResult:r=>results.push(r),onAccessRequest:async req=>{accessRequests++;if(req.requestedMode!=="folder"||req.targetPath!=="Projects")throw Error("bad request "+JSON.stringify(req));return true},onApprovalRequest:async()=>true,onError:e=>errors.push(e),onDone:()=>done++});
if(!protocolSeen)throw Error("request_access tool/protocol was not exposed");
if(accessRequests!==1)throw Error("access prompt count "+accessRequests);
if(!results[0]?.includes("granted temporary folder access"))throw Error("grant result missing: "+results[0]);
if(!results[1]?.includes("Projects/Plan.md")||results[1]?.includes("Private/Secret.md"))throw Error("folder grant leaked or failed: "+results[1]);
if(answer!=="Folder access worked and the run continued."||round!==3||done!==1||errors.length)throw Error("same run did not continue "+JSON.stringify({answer,round,done,errors}));
console.log("EXPLICIT_FOLDER_ACCESS_OK");
`;
const result=await build({stdin:{contents:entry,resolveDir:root,loader:"ts"},bundle:true,format:"esm",platform:"node",write:false,plugins:[electronMockPlugin,{name:"mock-obsidian",setup(b){b.onResolve({filter:/^obsidian$/},()=>({path:"obsidian",namespace:"mock"}));b.onLoad({filter:/.*/,namespace:"mock"},()=>({contents:obsidianMock,loader:"js"}))}}]});
await import("data:text/javascript;base64,"+Buffer.from(result.outputFiles[0].text).toString("base64"));
