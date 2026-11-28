import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentCapability, renderDocx, DOCX_MIME, type DocumentGrant, type DocumentPorts, type DocumentRow } from "../src/document-deliverable.ts";
import { runTool, type ToolEnv } from "../src/tools.ts";
import { tick, type Deps } from "../src/orchestrator.ts";
import { loadConfig } from "../src/config.ts";
import { Budget, DEFAULT_RATES } from "../src/budget.ts";
import type { Issue, StateType, TaskStore } from "../src/linear.ts";
import type { ModelClient } from "../src/providers.ts";
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
  const changes: ((f: ReturnType<typeof fixture>)=>void)[] = [f=>{f.env.document=undefined},f=>{f.env.dryRun=true},f=>f.stop(),f=>f.expire(),f=>f.share(),f=>{f.env.document=documentCapability(id(99),f.p)}];
  for(const change of changes){
    const f=fixture();try{change(f);assert.equal((await runTool(call,["document.create"],f.env)).ok,false);}finally{f.close()}
  }
  for(const x of [{...spec,filename:"../bad.docx"},{...spec,filename:"bad.pdf"},{...spec,threadId:id(4)},{...spec,title:"bad\u0000"},{...spec,sections:[]}])assert.throws(()=>renderDocx(x));
});

test("real goal planner and worker create one document, attach verified receipt, independently inspect and reconcile",async()=>{
  for(const fail of [false,true]){
    const f=fixture();
    try{
      const goal:Issue={id:id(10),identifier:"T-1",title:"[Goal] Produce synthetic report",description:"Make a private report",url:"",priority:3,stateType:"unstarted",stateName:"Todo",labels:[],assignee:null,parentId:null,childIds:[],createdAt:"2026-11-28T00:00:00Z"};
      const issues:Issue[]=[goal],notes=new Map<string,{body:string;createdAt:string}[]>();
      let n=0;
      const store:TaskStore={
        listOpenAndRecent:async()=>issues.map(i=>({...i,childIds:[...i.childIds]})),
        getComments:async id=>notes.get(id)??[],
        async createIssue(input){const child:Issue={...goal,id:f.grant.taskId,identifier:"T-2",title:input.title,description:input.description,parentId:goal.id,childIds:[],stateType:"unstarted",createdAt:"2026-11-28T00:01:00Z"};issues.push(child);goal.childIds.push(child.id);return child;},
        async comment(id,body){const a=notes.get(id)??[];a.push({body,createdAt:new Date(1760000000000+ ++n*1000).toISOString()});notes.set(id,a);},
        async setState(id,_team,state:StateType){issues.find(i=>i.id===id)!.stateType=state;}
      };
      const leadReplies=[JSON.stringify({summary:"Create private deliverable",tasks:[{agent:"chatgpt",title:"Write report",description:"Use document.create to create a report."}]}),JSON.stringify({status:"done",summary:"Verified synthetic report complete"})];
      const workerReplies=fail?[JSON.stringify({status:"done",final:"I made it (unverified)"})]:[JSON.stringify({tool:"document.create",input:spec}),JSON.stringify({status:"done",final:"Document prepared."})];
      const model=(replies:string[]):ModelClient=>({async chat(){const text=replies.shift();if(!text)throw Error("no reply");return {text,inputTokens:10,outputTokens:10};}});
      const cfg=loadConfig({ACP_ACTIVE:"true",ACP_DRY_RUN:"false"});
      const free={inputPerM:0,outputPerM:0,freeTier:true};
      const d:Deps={cfg,store,clients:{claude:model(leadReplies),chatgpt:model(workerReplies)},budget:new Budget({capUsd:0,path:null,rates:{...DEFAULT_RATES,claude:free,chatgpt:free}}),toolEnv:i=>({...f.env,document:i.id===f.grant.taskId?f.env.document:undefined,comment:b=>store.comment(i.id,b),requestApproval:async()=>assert.fail("approval")})};
      await tick(d);await tick(d);
      const child=issues[1]!;
      if(fail){assert.equal(child.stateType,"canceled");assert.ok((await store.getComments(child.id)).some(x=>x.body.includes("no confirmed current receipt")));continue;}
      assert.equal(child.stateType,"completed");
      const row=await documentCapability(child.id,f.p).retrieve(f.grant.principal);
      const receipt=await store.getComments(child.id);
      assert.ok(receipt.some(x=>x.body.includes("Verified artifact:")&&x.body.includes(row.receipt.sha256)));
      assert.equal(spawnSync("python3",["-c","import sys,io,zipfile,xml.etree.ElementTree as ET\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nassert z.testzip() is None\nroot=ET.fromstring(z.read('word/document.xml'))\nassert any('Readable synthetic evidence.'==x.text for x in root.iter())"],{input:row.data}).status,0);
      await tick(d);
      assert.equal(goal.stateType,"completed");assert.equal(d.budget.spentUsd(),0);
    }finally{f.close()}
  }
});
