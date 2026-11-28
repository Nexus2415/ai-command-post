import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentCapability, renderDocx, DOCX_MIME, type DocumentGrant, type DocumentPorts, type DocumentRow } from "../src/document-deliverable.ts";
import { runTool, type ToolEnv } from "../src/tools.ts";
const id=(n:number)=>"aaaaaaaa-aaaa-aaaa-aaaa-"+String(n).padStart(12,"0");
const spec={filename:"summary.docx",title:"Synthetic & report",sections:[{heading:"Findings",paragraphs:["A < B & C > D","Readable synthetic evidence."]}]};
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"arn169-"));
  let stopped:"off"|"on"|"error"="off",now=1000,priv=true;
  const grant:DocumentGrant={artifactId:id(1),taskId:id(2),projectId:id(3),threadId:id(4),principal:"owner-fixture",expiresAt:10000,syntheticOnly:true,maxBudgetMicros:0};
  const p:DocumentPorts={mode:"synthetic",now:()=>now,stop:async()=>stopped,grant:async t=>t===grant.taskId?structuredClone(grant):null,privateThread:async(a,b,c)=>priv&&a===grant.projectId&&b===grant.threadId&&c===grant.principal,
    async put(g,row){
      if(stopped!=="off"||!priv||now>=g.expiresAt||JSON.stringify(g)!==JSON.stringify(grant))throw Error("scope");
      const path=join(root,g.artifactId+".json");
      const encoded=JSON.stringify({receipt:row.receipt,data:row.data.toString("base64")});
      try{writeFileSync(path,encoded,{flag:"wx",mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST"||readFileSync(path,"utf8")!==encoded)throw e;}
      return row.receipt;
    },async get(g){if(stopped!=="off"||!priv||now>=g.expiresAt||JSON.stringify(g)!==JSON.stringify(grant))return null;
      const x=JSON.parse(readFileSync(join(root,g.artifactId+".json"),"utf8"));return {receipt:x.receipt,data:Buffer.from(x.data,"base64")} as DocumentRow;
    }};
  const env:ToolEnv={dryRun:false,policy:{allowPullRequests:false,allowedRepos:[]},comment:async()=>assert.fail("not a comment"),requestApproval:async()=>assert.fail("unexpected approval"),document:documentCapability(grant.taskId,p)};
  return {root,p,grant,env,stop:()=>{stopped="on"},expire:()=>{now=10001},share:()=>{priv=false},close:()=>rmSync(root,{recursive:true,force:true})};
}
test("real deterministic DOCX opens as valid ZIP and XML in independent Python standard-library reader",()=>{
  const f=renderDocx(spec);assert.equal(f.mime,DOCX_MIME);assert.deepEqual(f.data,renderDocx(spec).data);
  const result=spawnSync("python3",["-c","import sys,io,zipfile,xml.etree.ElementTree as ET\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nassert z.testzip() is None\nassert set(z.namelist())=={'[Content_Types].xml','_rels/.rels','word/document.xml'}\nfor name in z.namelist(): ET.fromstring(z.read(name))\nns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}\nroot=ET.fromstring(z.read('word/document.xml'))\nassert [p.text for p in root.findall('.//w:t',ns)]==['Synthetic & report','Findings','A < B & C > D','Readable synthetic evidence.']\nassert b'TargetMode' not in z.read('_rels/.rels')"],{input:f.data,encoding:"utf8"});
  assert.equal(result.status,0,result.error?.message??result.stderr);
});
test("existing tool handler creates a private file, retrieves after restart, exact replay only",async()=>{
  const f=fixture();try{
    const call={tool:"document.create",input:spec};
    const [a,b]=await Promise.all([runTool(call,["document.create"],f.env),runTool(call,["document.create"],f.env)]);
    assert.equal(a.ok,true,a.output);assert.deepEqual(a,b);
    assert.doesNotMatch(a.output,/base64|Readable synthetic evidence|owner-fixture/);
    const row=await documentCapability(f.grant.taskId,f.p).retrieve(f.grant.principal);
    assert.equal(row.receipt.sha256,createHash("sha256").update(row.data).digest("hex"));
    assert.deepEqual(row.data,renderDocx(spec).data);
    assert.equal((await runTool({...call,input:{...spec,title:"changed"}},["document.create"],f.env)).ok,false);
    await assert.rejects(documentCapability(f.grant.taskId,f.p).retrieve("other-owner"));
    f.share();await assert.rejects(documentCapability(f.grant.taskId,f.p).retrieve(f.grant.principal));
  }finally{f.close()}
});
test("missing capability, dry run, invalid scope, stop, expired and malformed input refuse",async()=>{
  const call={tool:"document.create",input:spec};
  for(const change of [(f:ReturnType<typeof fixture>)=>{f.env.document=undefined},f=>{f.env.dryRun=true},f=>f.stop(),f=>f.expire(),f=>f.share(),f=>{f.env.document=documentCapability(id(99),f.p)}]){
    const f=fixture();try{change(f);assert.equal((await runTool(call,["document.create"],f.env)).ok,false);}finally{f.close()}
  }
  for(const x of [{...spec,filename:"../bad.docx"},{...spec,filename:"bad.pdf"},{...spec,threadId:id(4)},{...spec,title:"bad\u0000"},{...spec,sections:[]}])assert.throws(()=>renderDocx(x));
});