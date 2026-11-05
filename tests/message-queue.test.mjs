import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

// 使用实际队列、存储和 Agent 循环。仅环境探测与工具目录使用受控夹具，模型只返回预设响应。
// 所有数据写入临时目录；不连接模型服务，不启动真实命令，也不访问用户数据库。
const root = path.resolve("src/lib");
const data = mkdtempSync(path.join(tmpdir(), "aai-queue-test-"));
process.env.A_DATA_DIR = data;
const require = createRequire(import.meta.url);
const cache = new Map();
const tool = { parallelSafe: true, spec: {name:"read_file",parameters:{type:"object",properties:{}}}, run: async () => ({content:"受控工具结果"}) };
const overrides = {
  "agent/tools/index.ts": { deferredCatalog:()=>"", toolsFor:()=>[tool.spec], findTool:n=>n==="read_file"?tool:undefined, toolSpecs:()=>[tool.spec] },
  "agent/env.ts": { envPrompt:async()=>"",turnEnv:async()=>"" },
  "agent/subagent.ts": {RESEARCH_SPEC:{name:"research"},runResearch:()=>{throw Error("unexpected research");}},
};
function load(name) {
  if (overrides[name]) return overrides[name];
  if (cache.has(name)) return cache.get(name).exports;
  const module={exports:{}};cache.set(name,module);
  const source=readFileSync(path.join(root,name),"utf8");
  const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  const localRequire = id => {
    if (id==="server-only") return {};
    if (id === "@/lib/llm") return load("llm/index.ts");
    if (id.startsWith("@/lib/")) return load(id.slice(6)+".ts");
    if (id.startsWith(".")) return load(path.relative(root,path.resolve(root,path.dirname(name),id))+".ts");
    return require(id);
  };
  new Function("require","module","exports",js)(localRequire,module,module.exports);
  return module.exports;
}
const {db}=load("server/db.ts");
const store=load("server/store.ts");
const q=load("server/message-queue.ts");
const runtime=load("server/notes.ts");
const {runAgent}=load("agent/run.ts");
db().exec("INSERT INTO users VALUES('u','u','x',0); INSERT INTO users VALUES('other','other','x',0)");
let seq=0;
function session() {
  const s=store.createSession("u");
  store.addMessage(s,{id:"start"+ ++seq,role:"user",content:"原始任务：分析销售",createdAt:1});
  return s;
}
function add(s,text="只统计已付款订单") { const id="queue"+ ++seq;q.enqueue(s.id,"u",text,id);return id; }
function options(s,provider,extra={}) {
 return {session:s,provider,workspace:data,userId:"u",maxSteps:5,maxFixRounds:0,
  notes:()=>q.readyNotes(s.id),noteSaved:(id,m)=>q.noteSaved(s.id,id,m),notesSent:msgs=>q.notesSent(s,msgs),
  onClosing:()=>runtime.closeRun(s.id),...extra};
}
async function collect(opts) {const events=[];for await(const e of runAgent(opts)) events.push(e);return events;}
const answer=()=>({async *stream(){yield{type:"text",delta:"处理完成"};yield{type:"done"};}});
after(()=>{db().close();delete globalThis.__aDb;rmSync(data,{recursive:true,force:true});});

test("普通入队不进入正式对话，同文不同 ID、同 ID 重试可区分",async()=>{
 const s=session(),a=add(s),b=add(s);
 q.enqueue(s.id,"u","只统计已付款订单",a);
 assert.equal(q.listQueue(s.id,"u").length,2);
 await collect(options(s,answer()));
 assert.equal(store.getSession(s.id,"u").messages.filter(m=>m.feedback?.kind==="note").length,0);
 assert.deepEqual(q.listQueue(s.id,"u").map(m=>m.id),[a,b]);
});

test("三条消息逐位上移，第一条才可插队，草稿可编辑删除",()=>{
 const s=session(),a=add(s,"A"),b=add(s,"B"),c=add(s,"C");
 q.changeQueue(s.id,"u",c,"up");
 assert.deepEqual(q.listQueue(s.id,"u").map(m=>m.id),[a,c,b]);
 assert.equal(q.listQueue(s.id,"u")[1].status,"queued");
 assert.throws(()=>q.changeQueue(s.id,"u",c,"steer"),/第一位/);
 q.changeQueue(s.id,"u",c,"edit","C 修改");
 q.changeQueue(s.id,"u",b,"remove");
 q.changeQueue(s.id,"u",c,"up");
 q.changeQueue(s.id,"u",c,"steer");
 q.changeQueue(s.id,"u",c,"steer");
 assert.equal(q.readyNotes(s.id)[0].text,"C 修改");
 assert.throws(()=>q.changeQueue(s.id,"u",c,"edit","改"),/执行器/);
 assert.throws(()=>q.changeQueue(s.id,"u",c,"remove"),/执行器/);
});

test("权限、空内容、长度和数量上限在服务端检查",()=>{
 const s=session(),id=add(s);
 assert.throws(()=>q.listQueue(s.id,"other"),/不存在/);
 assert.throws(()=>q.changeQueue(s.id,"other",id,"remove"),/不存在/);
 assert.throws(()=>q.enqueue(s.id,"u"," "),/字符/);
 assert.throws(()=>q.enqueue(s.id,"u","a".repeat(12001)),/字符/);
 for(let i=1;i<50;i++) add(s);
 assert.throws(()=>add(s),/50/);
});

test("当前请求不被改写，下一请求包含原始任务、工具结果及选择插队的内容",async()=>{
 const s=session(),id=add(s),later=add(s,"不应自动发送的草稿"),requests=[];
 const provider={async *stream(req){
   requests.push(structuredClone(req));
   if(requests.length===1){
     q.changeQueue(s.id,"u",id,"steer");
     assert.equal(q.listQueue(s.id,"u").find(x=>x.id===id).status,"ready");
     yield{type:"tool_call",call:{id:"read1",name:"read_file",arguments:"{}"}};
   }else{
     assert.equal(q.listQueue(s.id,"u").find(x=>x.id===id).status,"received");
     yield{type:"text",delta:"按新条件处理"};
   }
   yield{type:"done"};
 }};
 await collect(options(s,provider));
 assert.equal(requests[0].messages.some(m=>m.content.includes("只统计已付款订单")),false);
 const next=requests[1].messages;
 assert.ok(next.some(m=>m.content.includes("原始任务")));
 assert.ok(next.some(m=>m.role==="tool" && m.content==="受控工具结果"));
 assert.ok(next.some(m=>m.role==="user" && m.content.includes("只统计已付款订单")));
 assert.equal(q.listQueue(s.id,"u").find(x=>x.id===id).status,"sent");
 assert.equal(q.listQueue(s.id,"u").find(x=>x.id===later).status,"queued");
});

test("最后总结时插队会继续请求，给补充内容留下调用工具的机会",async()=>{
 const s=session(),id=add(s);let n=0;let continued=false;
 const provider={async *stream(req){
   n++;
   if(n===1) yield{type:"tool_call",call:{id:"read-final",name:"read_file",arguments:"{}"}};
   else if(n===2){q.changeQueue(s.id,"u",id,"steer");yield{type:"text",delta:"原总结"};}
   else {continued=!!req.tools?.length;yield{type:"text",delta:"新总结"};}
   yield{type:"done"};
 }};
 await collect(options(s,provider,{maxSteps:2}));
 assert.equal(n,3);assert.equal(continued,true);
 assert.equal(q.listQueue(s.id,"u").find(x=>x.id===id).status,"sent");
});

test("模型请求失败不伪报送达，重试复用正式消息，不重复写入",async()=>{
 const s=session(),id=add(s);q.changeQueue(s.id,"u",id,"steer");
 const failed={async *stream(){throw Error("可控网络失败");}};
 await collect(options(s,failed));
 assert.equal(q.listQueue(s.id,"u")[0].status,"received");
 const reloaded=store.getSession(s.id,"u");
 await collect(options(reloaded,answer()));
 assert.equal(q.listQueue(s.id,"u")[0].status,"sent");
 assert.equal(store.getSession(s.id,"u").messages.filter(m=>m.id==="mq_"+id).length,1);
});

test("停止/关闭运行不丢草稿，重开数据库后队列仍存在",()=>{
 const s=session(),a=add(s),b=add(s);q.changeQueue(s.id,"u",a,"steer");
 runtime.openRun(s.id,"u");runtime.closeRun(s.id);
 db().close();delete globalThis.__aDb;
 assert.deepEqual(q.listQueue(s.id,"u").map(m=>m.status),["ready","queued"]);
 assert.equal(q.queuedTurn(s.id,"u",a).id,a);
 assert.throws(()=>q.queuedTurn(s.id,"u",b),/第一条/);
});

test("未送达消息退出历史版本后回到草稿，新消息主键不与旧历史冲突",()=>{
 const s=session(),id=add(s);q.changeQueue(s.id,"u",id,"steer");
 const note=q.readyNotes(s.id)[0];
 store.addMessage(s,{id:note.messageId,role:"user",content:note.text,createdAt:2});
 q.noteSaved(s.id,id,note.messageId);
 store.truncateFrom(s,note.messageId);
 const reset=q.listQueue(s.id,"u").find(x=>x.id===id);
 assert.equal(reset.status,"queued");assert.notEqual(reset.messageId,note.messageId);
 assert.equal(db().prepare("SELECT COUNT(*) AS n FROM messages WHERE id=?").get(note.messageId).n,1);
});

test("领取与写入回执之间中断可恢复，不重复保存且不误确认未实际进入请求的内容",async()=>{
 const s=session(),id=add(s);q.changeQueue(s.id,"u",id,"steer");
 store.addMessage(s,{id:"mq_"+id,role:"user",content:"【用户补充】只统计已付款订单",feedback:{kind:"note",summary:"只统计已付款订单"},createdAt:2});
 q.notesSent(s,[{role:"system",content:"不包含该消息"}]);
 assert.equal(q.listQueue(s.id,"u")[0].status,"ready");
 await collect(options(s,answer()));
 assert.equal(q.listQueue(s.id,"u")[0].status,"sent");
 assert.equal(store.getSession(s.id,"u").messages.filter(m=>m.id==="mq_"+id).length,1);
});


test("运行占用是原子的，旧请求释放时不会删除新运行",()=>{
 const s=session();
 const first=runtime.openRun(s.id,"u");
 assert.ok(first);assert.equal(runtime.openRun(s.id,"u"),false);
 runtime.closeRun(s.id,first);
 const second=runtime.openRun(s.id,"u");
 runtime.closeRun(s.id,first);
 assert.equal(runtime.isRunning(s.id),true);
 runtime.closeRun(s.id,second);
 assert.equal(runtime.isRunning(s.id),false);
});

// 端口受限时，直接调用实际 Next 路由函数：Request/Response/SSE 仍使用 Node 原生实现。
// 只替换登录身份、模型和无关后台服务，避免触碰真实凭据、外部模型和用户工作区。
let routeUser = "u";
let routeProvider = answer();
Object.assign(overrides, {
 "server/auth.ts": { currentUser:async()=>routeUser?{id:routeUser}:null, unauthorized:()=>Response.json({error:"未登录"},{status:401}) },
 "llm/index.ts": { getProvider:()=>routeProvider },
 "server/settings.ts": {getSettings:()=>({memory:false,skills:false,currentModel:"mock",connections:[],commandApproval:"auto",maxSteps:5,maxFixRounds:0})},
 "server/projects.ts": {getProject:()=>null},
 "server/memory.ts": {},
 "server/skills.ts": {},
 "agent/reflect.ts": {},
 "agent/learn.ts": {},
 "server/sandbox.ts": {sandboxPrompt:()=>"",unavailableTools:async()=>({})},
 "agent/tools/files.ts": {workspaceOf:()=>data},
});
const noteRoute=load("../app/api/chat/note/route.ts");
const chatRoute=load("../app/api/chat/route.ts");
const post=(route,body)=>route.POST(new Request("http://test/api",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}));

test("实际聊天与队列接口：运行中入队/编辑/排序/插队、下一请求接收、结束后按原文发送",async()=>{
 const s=session(),requests=[];
 let release,seen;
 const gate=new Promise(resolve=>{release=resolve;});
 const first=new Promise(resolve=>{seen=resolve;});
 routeProvider={async *stream(req){
   requests.push(structuredClone(req));
   if(requests.length===1){seen();await gate;}
   yield{type:"text",delta:"受控接口回答"};yield{type:"done"};
 }};
 const response=await post(chatRoute,{sessionId:s.id,message:"本轮原始任务"});
 assert.equal(response.status,200);
 const events=response.text();
 await first;
 for(const [id,message] of [["api_a","A"],["api_b","B"],["api_c","C"]]){
   assert.equal((await post(noteRoute,{sessionId:s.id,action:"enqueue",id,message})).status,200);
 }
 assert.equal((await post(noteRoute,{sessionId:s.id,action:"edit",id:"api_c",message:"只统计已付款"})).status,200);
 assert.equal((await post(noteRoute,{sessionId:s.id,action:"up",id:"api_c"})).status,200);
 assert.deepEqual(q.listQueue(s.id,"u").map(m=>m.id),["api_a","api_c","api_b"]);
 assert.equal((await post(noteRoute,{sessionId:s.id,action:"steer",id:"api_c"})).status,400);
 assert.equal((await post(noteRoute,{sessionId:s.id,action:"remove",id:"api_b"})).status,200);
 assert.equal((await post(noteRoute,{sessionId:s.id,action:"up",id:"api_c"})).status,200);
 assert.equal((await post(noteRoute,{sessionId:s.id,action:"steer",id:"api_c"})).status,200);
 release();
 assert.ok((await events).includes('"type":"done"'));
 assert.equal(requests.length,2);
 assert.ok(requests[1].messages.some(m=>m.content.includes("本轮原始任务")));
 assert.ok(requests[1].messages.some(m=>m.content.includes("只统计已付款")));
 assert.equal(q.listQueue(s.id,"u").find(m=>m.id==="api_c").status,"sent");
 assert.equal(q.listQueue(s.id,"u").find(m=>m.id==="api_a").status,"queued");
 assert.equal((await post(noteRoute,{sessionId:s.id,action:"steer",id:"api_a"})).status,409);
 const next=await post(chatRoute,{sessionId:s.id,message:"客户端伪造正文",queuedMessageId:"api_a"});
 assert.equal(next.status,200);await next.text();
 const saved=store.getSession(s.id,"u");
 assert.ok(saved.messages.some(m=>m.id==="mq_api_a" && m.content==="A"));
 assert.equal(saved.messages.some(m=>m.content==="客户端伪造正文"),false);
 assert.equal(runtime.isRunning(s.id),false);
 routeProvider=answer();
});

test("实际队列接口拒绝跨用户读取与修改，未登录返回401",async()=>{
 const s=session(),id=add(s);
 routeUser="other";
 try {
   assert.equal((await noteRoute.GET(new Request("http://test/api/chat/note?sessionId="+s.id))).status,404);
   assert.equal((await post(noteRoute,{sessionId:s.id,id,action:"remove"})).status,400);
   routeUser="";
   assert.equal((await noteRoute.GET(new Request("http://test/api/chat/note?sessionId="+s.id))).status,401);
 }finally{routeUser="u";}
 assert.equal(q.listQueue(s.id,"u").length,1);
});

test("同文回执按原消息ID判断，不确认未进入本次请求的另一条消息",()=>{
 const s=session(),a=add(s,"相同文字"),b=add(s,"相同文字");
 for(const id of [a,b]){
   q.changeQueue(s.id,"u",id,"steer");
   store.addMessage(s,{id:"mq_"+id,role:"user",content:"相同文字",createdAt:2});
   q.noteSaved(s.id,id,"mq_"+id);
 }
 q.notesSent(s,[{role:"user",content:"相同文字",sourceMessageId:"mq_"+b}]);
 assert.equal(q.listQueue(s.id,"u").find(m=>m.id===a).status,"received");
 assert.equal(q.listQueue(s.id,"u").find(m=>m.id===b).status,"sent");
});
