import { electronMockPlugin } from "./esbuild-electron-mock.mjs";
import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";
const root=path.dirname(fileURLToPath(import.meta.url));
const obsidianMock=`
var TFile=class{constructor(p){this.path=p;this.extension='md';this.basename=p.replace(/\\.md$/,'');this.name=p;this.stat={size:1,ctime:0,mtime:0}}};
var TFolder=class{constructor(p){this.path=p;this.children=[]}};
var Notice=class{};
var Modal=class{constructor(){}open(){}close(){}};
var PluginSettingTab=class{constructor(){}};
var Setting=class{constructor(){}setName(){return this}setDesc(){return this}addText(){return this}addDropdown(){return this}addToggle(){return this}addButton(){return this}addTextArea(){return this}};
var requestUrl=async()=>({status:200,text:'',json:()=>({})});
export {TFile,TFolder,Notice,Modal,PluginSettingTab,Setting,requestUrl};
`;
const entry=`
import { AgentOrchestrator } from "../src/orchestrator";
import { OpenAIProvider } from "../src/api";
import { TFile, TFolder } from "obsidian";
const allowed=new TFile("Allowed.md"), secret=new TFile("Secret.md"), root=new TFolder("");root.children=[allowed,secret];
const app={vault:{getRoot(){return root},getMarkdownFiles(){return[allowed,secret]},getFiles(){return[allowed,secret]},getAbstractFileByPath(p){return p==="Allowed.md"?allowed:p==="Secret.md"?secret:p===""?root:null},async read(f){return f.path==="Secret.md"?"TOP SECRET":"ALLOWED"},async cachedRead(f){return this.read(f)}},workspace:{getActiveFile(){return allowed}},metadataCache:{},fileManager:{}};
const settings={providers:[{id:"p",name:"OpenAI",type:"openai",baseUrl:"https://api.openai.com/v1",apiKey:"x",model:"gpt-4o",extraHeaders:"",supportsWebSearch:true,supportsVision:true}],activeProviderId:"p",maxTokens:1000,temperature:.2,systemPrompt:"test",toolApproval:{}};
let round=0;
OpenAIProvider.prototype.chat=async function(messages,tools,cb){
 round++;
 if(round===1){
   if(!tools.some(t=>t.name==="search_notes")) throw new Error("wider tools hidden from model");
   cb.onToolCalls([{id:"call-secret",name:"read_note",arguments:JSON.stringify({path:"Secret.md"})}]);
 } else { cb.onToken("Continued after approved access."); cb.onToolCalls([]); }
 cb.onDone();
};
const orchestrator=new AgentOrchestrator(app,settings);
orchestrator.setAccessScope({mode:"note",notePath:"Allowed.md",folderPath:""});
let requested=0,toolResult="",answer="",errors=[],done=0;
await orchestrator.run("Need the other note",{
 onAssistantToken:t=>answer+=t,
 onToolUse:()=>{},
 onToolResult:r=>toolResult=r,
 onAccessRequest:async req=>{requested++;if(req.requestedMode!=="note"||req.targetPath!=="Secret.md")throw new Error("bad request "+JSON.stringify(req));return true},
 onApprovalRequest:async()=>true,
 onError:e=>errors.push(e),
 onDone:()=>done++,
});
if(requested!==1)throw new Error("access prompt count "+requested);
if(toolResult!=="TOP SECRET")throw new Error("tool did not resume: "+toolResult);
if(answer!=="Continued after approved access.")throw new Error("assistant loop did not continue: "+answer);
if(errors.length||done!==1||round!==2)throw new Error("run lifecycle failed "+JSON.stringify({errors,done,round}));
console.log("ACCESS_RESUME_OK");
`;
const result=await build({stdin:{contents:entry,resolveDir:root,loader:"ts"},bundle:true,format:"esm",platform:"node",write:false,plugins:[electronMockPlugin,{name:"mock-obsidian",setup(b){b.onResolve({filter:/^obsidian$/},()=>({path:"obsidian",namespace:"mock"}));b.onLoad({filter:/.*/,namespace:"mock"},()=>({contents:obsidianMock,loader:"js"}))}}]});
await import("data:text/javascript;base64,"+Buffer.from(result.outputFiles[0].text).toString("base64"));
