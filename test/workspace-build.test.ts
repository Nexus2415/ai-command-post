import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handle } from "../api/workspace.js";
import { createMemoryStore } from "../api/_lib/workspace-store.js";
import { makeSessionToken, SESSION_COOKIE } from "../api/_lib/site-auth.js";
import { readFileSync } from "node:fs";

const env = { ACP_SITE_PASSWORD: "synthetic-password", ACP_WORKSPACE_DB_URL: "https://synthetic.supabase.co",
  ACP_WORKSPACE_DB_KEY: "synthetic-key", ACP_GITHUB_REPOS: "Nexus2415/ai-command-post",
  ACP_WORKSPACE_MONTHLY_BUDGET_USD: "0" };
const headers = { "x-acp-password": env.ACP_SITE_PASSWORD, origin: "https://acp.example", host: "acp.example" };
const data = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\x1a\n", "latin1"), Buffer.alloc(40, 7)]).toString("base64");
async function setup() {
  const store = createMemoryStore();
  let calls = 0;
  const call = (action: string, args: object = {}, e = env, h: Record<string,string> = headers) =>
    handle({ method: "POST", headers: h, body: { action, args } }, e, () => store,
      { fetch: (async () => { calls++; throw Error("unexpected network"); }) as typeof fetch, now: () => new Date("2026-11-28T12:00:00Z") });
  const p = ((await call("create_project", { name: "Synthetic" })).body as any).project;
  const t = ((await call("create_thread", { projectId: p.id, title: "Build", model: "claude" })).body as any).thread;
  await call("set_private", { threadId: t.id, private: true });
  const img = ((await call("upload_file", { threadId: t.id, name: "synthetic.png", mime: "image/png", data })).body as any).file;
  const args = { projectId: p.id, threadId: t.id, repository: "Nexus2415/ai-command-post", content: "Build a synthetic demo", files: [img.id], syntheticOnly: true };
  return { call, store, args, calls: () => calls };
}
test("private synthetic build preview hashes bytes without models, messages or dispatch", async () => {
  const { call, args, calls } = await setup();
  const out = await call("build_preview", args);
  assert.equal(out.status, 200);
  const p = (out.body as any).preview;
  assert.equal(p.references[0].sha256, createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"));
  assert.deepEqual([p.modelCalled, p.goalCreated, p.dispatchAvailable, p.costUsd], [false,false,false,0]);
  assert.equal(p.inferred.length, 0);
  assert.doesNotMatch(JSON.stringify(p), /data:|base64/);
  assert.equal(((await call("get_thread", { threadId: args.threadId })).body as any).messages.length, 0);
  assert.equal((await call("build_submit", args)).status, 400);
  assert.equal(calls(), 0);
});
test("build preview refuses cross-thread refs, unknown repos, duplicates, shared threads, stop and missing auth", async () => {
  const { call, args, calls } = await setup();
  const other = ((await call("create_thread", { projectId: args.projectId, title: "Other", model: "claude" })).body as any).thread;
  await call("set_private", { threadId: other.id, private: true });
  assert.equal((await call("build_preview", { ...args, threadId: other.id })).status, 404);
  assert.equal((await call("build_preview", { ...args, repository: "elsewhere/repo" })).status, 403);
  assert.equal((await call("build_preview", args, { ...env, ACP_GITHUB_REPOS: "" })).status, 403);
  assert.equal((await call("build_preview", { ...args, files: [...args.files, ...args.files] })).status, 400);
  assert.equal((await call("build_preview", { ...args, syntheticOnly: false })).status, 400);
  assert.equal((await call("build_preview", { ...args, approval: true })).status, 400);
  assert.equal((await call("build_preview", args, env, { ...headers, "x-acp-password": "wrong" })).status, 401);
  await call("set_private", { threadId: args.threadId, private: false });
  assert.equal((await call("build_preview", args)).status, 403);
  await call("set_private", { threadId: args.threadId, private: true });
  await call("set_control", { stopped: true });
  assert.equal((await call("build_preview", args)).status, 423);
  assert.equal(calls(), 0);
});
test("composer Build mode intercepts Send before any chat and explicitly refuses dispatch", () => {
  const js = readFileSync(new URL("../dashboard/workspace.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../dashboard/workspace.html", import.meta.url), "utf8");
  assert.match(js, /if \(buildMode\) \{ await previewBuild\(\); return; \}/);
  assert.match(js, /post\("build_preview"/);
  assert.match(html, /disabled>Start autonomous build \(not yet available\)/);
  assert.doesNotMatch(js, /post\("build_submit"/);
});


test("unreadable stop state, missing image and project mismatch fail closed", async () => {
  const { call, store, args, calls } = await setup();
  assert.equal((await call("build_preview", { ...args, projectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" })).status, 403);
  assert.equal((await call("build_preview", { ...args, files: [] })).status, 400);
  const pdf = ((await call("upload_file", { threadId: args.threadId, name: "synthetic.pdf", mime: "application/pdf", data: Buffer.from("%PDF-1.7 synthetic").toString("base64") })).body as any).file;
  assert.equal((await call("build_preview", { ...args, files: [pdf.id] })).status, 400);
  store.getControl = async () => { throw Error("unavailable"); };
  assert.equal((await call("build_preview", args)).status, 423);
  assert.equal(calls(), 0);
});

test("only named owner session can save the exact reviewed scope; no dispatch or model call", async()=>{
  const {call,store,args,calls}=await setup();
  const ownerEnv={...env,ACP_OWNER_EMAIL:"owner@example.test"};
  const cookie=SESSION_COOKIE+"="+makeSessionToken(ownerEnv,"owner@example.test",false,Date.parse("2026-11-28T12:00:00Z"));
  const h={origin:headers.origin,host:headers.host,cookie};
  let writes=0;
  const staged=new Map<string,any>();
  Object.assign(store,{saveBuildScope:async (p:any)=>{const old=staged.get(p.p_id);if(old){assert.deepEqual(old,p);return {scope_id:p.p_id,outcome:"already_saved"};} staged.set(p.p_id,p);writes++;return {scope_id:p.p_id,outcome:"saved"};}});
  const ticket=((await call("build_preview",args,ownerEnv,h)).body as any).scopeTicket;
  assert.ok(ticket?.id);
  assert.equal(((await call("build_preview",args,ownerEnv)).body as any).scopeTicket,undefined);
  assert.equal((await call("build_save_scope",{...args,ticket},ownerEnv)).status,403);
  assert.equal((await call("build_save_scope",{...args,content:"changed",ticket},ownerEnv,h)).status,409);
  assert.equal((await call("build_save_scope",{...args,ticket:{...ticket,signature:"0".repeat(64)}},ownerEnv,h)).status,409);
  assert.equal((await call("build_save_scope",{...args,ticket:{...ticket,expiresAt:1}},ownerEnv,h)).status,409);
  const other={...h,cookie:SESSION_COOKIE+"="+makeSessionToken(ownerEnv,"other@example.test",false,Date.parse("2026-11-28T12:00:00Z"))};
  assert.equal((await call("build_save_scope",{...args,ticket},ownerEnv,other)).status,403);
  assert.equal(writes,0);
  const saved=await call("build_save_scope",{...args,ticket},ownerEnv,h);
  assert.equal(saved.status,200);
  assert.deepEqual((saved.body as any).scope,{id:ticket.id,state:"scope_saved",dispatchAvailable:false,goalCreated:false,costUsd:0});
  assert.equal((await call("build_save_scope",{...args,ticket},ownerEnv,h)).status,200);
  assert.equal(writes,1);
  const row=staged.get(ticket.id);assert.equal(row.p_manifest.files[0].id,args.files[0]);
  assert.doesNotMatch(JSON.stringify(row),/base64|owner@example/);
  await call("set_control",{stopped:true});
  assert.equal((await call("build_save_scope",{...args,ticket},ownerEnv,h)).status,423);
  assert.equal(calls(),0);
});

test("private Build composer clears draft on exit and binds async uploads to original context",()=>{
  const js=readFileSync(new URL("../dashboard/workspace.js",import.meta.url),"utf8");
  assert.match(js,/const wasBuild=buildMode;[\s\S]{0,160}if \(wasBuild\) \{ \$\("cText"\)\.value = ""; files = \[\]; uploads = \[\];/);
  assert.match(js,/if \(p !== true && buildMode\) \{ resetBuild\(\)/);
  assert.match(js,/const data = await base64\(blob\);\s*assertAttachmentScope\(scope\);\s*const \{ file: saved \} = await post\("upload_file", \{ threadId:scope\.threadId/);
  assert.match(js,/mime, data \}\);\s*assertAttachmentScope\(scope\);\s*uploads\.push\(saved\)/);
  assert.match(js,/if\(scope\.buildMode && !\/\^image/);
});


test("Build mode aborts ordinary speech recognition and stale callbacks cannot repopulate another draft", async()=>{
  const {runInNewContext}=await import("node:vm");
  const js=readFileSync(new URL("../dashboard/workspace.js",import.meta.url),"utf8");
  assert.match(js,/abortRecognition\(\);[^\n]*\n\s*buildMode = true/);
  assert.match(js,/function resetBuild[^\n]*\{\s*abortRecognition\(\)/);
  assert.match(js,/if \(halted\) \{ abortRecognition\(\); invalidateBuild\(\); \}/);
  const start=js.indexOf("  const Recognition = window.SpeechRecognition");
  const end=js.indexOf("  // Read aloud:",start);
  assert.ok(start>=0 && end>start);
  const fake=runInNewContext(
    "let rec=null, buildMode=false, halted=false, threadId='a',projectId='p',buildModeEpoch=1,files=[],uploads=[];"+
    "let sessions=[], handlers={}, nodes={}; const $=id=>nodes[id]??=( {value:'',textContent:'',hidden:false,classList:{add(){},remove(){}},setAttribute(){},focus(){},addEventListener(e,f){handlers[id]=f}} );"+
    "const say=t=>{$('pageMsg').textContent=t},grow=()=>{},attachmentScope=()=>({threadId,projectId,epoch:buildModeEpoch});"+
    "const navigator={language:'en-US'},window={SpeechRecognition:class{constructor(){sessions.push(this)}start(){}stop(){}abort(){this.aborted=true}}};"+
    js.slice(start,end)+
    "({sessions,nodes,click:()=>handlers.cMic(),result:(f,t)=>f({results:[[{transcript:t}]]}),abort:abortRecognition,enter:()=>{abortRecognition();buildMode=true;buildModeEpoch++;$('cText').value='private draft'},exit:()=>{abortRecognition();buildMode=false;buildModeEpoch++;$('cText').value=''},switchThread:()=>{abortRecognition();threadId='b';buildModeEpoch++;$('cText').value='new thread'},active:()=>rec})"
  );
  fake.click();
  const first=fake.sessions[0],late=first.onresult,lateEnd=first.onend;
  fake.result(late,"ordinary");assert.equal(fake.nodes.cText.value,"ordinary");
  fake.enter();assert.equal(first.aborted,true);
  fake.result(late,"must not leak");lateEnd();assert.equal(fake.nodes.cText.value,"private draft");
  fake.click();assert.equal(fake.sessions.length,1);
  fake.exit();fake.click();const second=fake.sessions[1];
  lateEnd();assert.equal(fake.active(),second);
  const stale=second.onresult;fake.switchThread();assert.equal(second.aborted,true);
  fake.result(stale,"must not repopulate");assert.equal(fake.nodes.cText.value,"new thread");
});
