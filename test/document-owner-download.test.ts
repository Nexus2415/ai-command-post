import assert from "node:assert/strict";
import { test } from "node:test";
import { makeSessionToken, SESSION_COOKIE } from "../api/_lib/site-auth.js";
import { documentOwnerPrincipal, ownerDocumentDownload } from "../api/_lib/document-owner-download.js";
import { renderDocx } from "../src/document-deliverable.ts";
const id=(n:number)=>"bbbbbbbb-bbbb-bbbb-bbbb-"+String(n).padStart(12,"0");
const now=1000000000, env={ACP_SITE_PASSWORD:"synthetic-password",ACP_OWNER_EMAIL:"owner@example.invalid"};
const req=(email="owner@example.invalid")=>({method:"POST",headers:{host:"example.invalid",origin:"https://example.invalid",cookie:SESSION_COOKIE+"="+makeSessionToken(env,email,false,now)}});
const scope={artifactId:id(1),projectId:id(2),threadId:id(3)};
const file=renderDocx({filename:"verified.docx",title:"Synthetic report",sections:[{heading:"Summary",paragraphs:["Private document."]}]});
const receipt={...scope,taskId:id(4),filename:file.filename,mime:file.mime,bytes:file.data.length,sha256:file.sha256};
test("candidate named-owner download returns only exact scoped verified bytes, no-store and attachment",async()=>{
  const r=await ownerDocumentDownload(req(),env,scope,async (a:Record<string,string>)=>{
    assert.deepEqual(a,{p_artifact:scope.artifactId,p_project:scope.projectId,p_thread:scope.threadId,p_principal:documentOwnerPrincipal(req(),env,now)});
    return {ok:true,receipt,data:file.data.toString("base64")};
  },now);
  assert.equal(r.status,200);assert.deepEqual(r.body,file.data);assert.equal(r.headers["Cache-Control"],"no-store");
  assert.ok("Content-Disposition" in r.headers);
  assert.equal(r.headers["Content-Disposition"],'attachment; filename="verified.docx"');
});
test("candidate owner download rejects anonymous, password-only, other owner, cross-site, expired and forged scopes before any read",async()=>{
  let calls=0;const read=async()=>{calls++;return {ok:false};};
  const cases=[{...req(),headers:{host:"example.invalid",origin:"https://example.invalid","x-acp-password":env.ACP_SITE_PASSWORD}},req("other@example.invalid"),{...req(),headers:{...req().headers,origin:"https://other.invalid"}}];
  for(const r of cases)assert.notEqual((await ownerDocumentDownload(r,env,scope,read,now)).status,200);
  assert.equal((await ownerDocumentDownload(req(),env,scope,read,now+86400000)).status,401);
  assert.equal((await ownerDocumentDownload(req(),{...env,ACP_OWNER_EMAIL:""},scope,read,now)).status,401);
  assert.equal((await ownerDocumentDownload(req(),env,{...scope,principal:"forged"},read,now)).status,400);
  assert.equal(calls,0);
  assert.equal((await ownerDocumentDownload(req(),env,scope,undefined,now)).status,503);
});
test("candidate owner download refuses incorrect scope, altered bytes, malicious filename and unavailable storage",async()=>{
  const good={ok:true,receipt,data:file.data.toString("base64")};
  for(const row of [{...good,receipt:{...receipt,threadId:id(99)}},{...good,receipt:{...receipt,filename:"../x.docx"}},{...good,data:Buffer.from("wrong").toString("base64")},{ok:false},null]){
    const r=await ownerDocumentDownload(req(),env,scope,async()=>row,now);
    assert.notEqual(r.status,200);assert.equal(Buffer.isBuffer(r.body),false);
  }
  assert.equal((await ownerDocumentDownload(req(),env,scope,async()=>{throw Error("unavailable");},now)).status,503);
});
