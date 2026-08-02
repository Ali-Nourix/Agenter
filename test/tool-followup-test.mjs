import { build } from "esbuild";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({ entryPoints:[path.join(root,"src/api.ts")], bundle:true, format:"esm", platform:"node", write:false, plugins:[{name:"mock-obsidian",setup(ctx){ctx.onResolve({filter:/^obsidian$/},()=>({path:"obsidian",namespace:"mock"}));ctx.onLoad({filter:/.*/,namespace:"mock"},()=>({contents:'export const requestUrl=async()=>{throw new Error("unexpected fallback")}',loader:"js"}));}}] });
const moduleUrl="data:text/javascript;base64,"+Buffer.from(result.outputFiles[0].text).toString("base64");
const {OpenAIProvider}=await import(moduleUrl);
let received;
const server=createServer((req,res)=>{let body="";req.on("data",c=>body+=c);req.on("end",()=>{received=JSON.parse(body);res.writeHead(200,{"Content-Type":"text/event-stream"});res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');});});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const addr=server.address();
const provider=new OpenAIProvider({id:"t",name:"t",type:"openai-compatible",baseUrl:`http://127.0.0.1:${addr.port}`,apiKey:"x",model:"gpt-oss",extraHeaders:"",supportsWebSearch:false,supportsVision:false});
await provider.chat([
 {role:"user",content:[{type:"text",text:"read note"}]},
 {role:"assistant",content:null,tool_calls:[{id:"call-1",name:"request_access",arguments:'{"scope":"folder"}'}]},
 {role:"tool",content:{granted:true,path:"folder"},tool_call_id:"call-1"}
],[],{onToken(){},onDone(){},onError(e){throw e;}});
server.close();
if(!received.messages.every(m=>typeof m.content==="string")) throw new Error(`Non-string content: ${JSON.stringify(received.messages)}`);
if(received.messages[1].content!=="") throw new Error("Assistant tool-call content must be an empty string");
if(received.messages[2].tool_call_id!=="call-1") throw new Error("Tool call id changed");
console.log("TOOL FOLLOW-UP TEST PASSED");
