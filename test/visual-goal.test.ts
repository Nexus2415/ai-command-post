import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createVisualGoalIntake, type VisualGrant, type VisualPorts, type GoalDraft } from "../src/visual-goal.ts";
import type { AttemptState } from "../src/manager.ts";

const id = (n: number) => "aaaaaaaa-aaaa-aaaa-aaaa-"+String(n).padStart(12,"0");
const bytes = Buffer.concat([Buffer.from([0x89]),Buffer.from("PNG\r\n\x1a\n","latin1"),Buffer.alloc(40,7)]);
export function fixture() {
  let now = 1000, stopped: "off"|"on"|"error" = "off", state: AttemptState = "claimed", fence = 1, calls = 0, commits = 0;
  const grant: VisualGrant = { grantId:id(1),principal:"synthetic-owner",projectId:id(2),threadId:id(3),
    goalId:id(4),claimId:id(5),attemptId:id(6),fence:1,repository:"acme/app",prompt:"Build a synthetic status card",
    files:[{id:id(7),sha256:createHash("sha256").update(bytes).digest("hex")}],expiresAt:10000,
    approved:true,syntheticOnly:true,maxBudgetMicros:0 };
  const q = { grantId:grant.grantId,principal:grant.principal,goalId:grant.goalId,attemptId:grant.attemptId,fence:1 };
  let draft: GoalDraft | undefined;
  const p: VisualPorts = { mode:"synthetic",now:()=>now,stop:async()=>stopped,grant:async()=>structuredClone(grant),
    repositories:()=>["acme/app"],broker:{
      claimStatus:async()=>({ok:true,attemptId:grant.attemptId,fence,state}),
      markDispatched:async(a,f)=>{ if(a!==grant.attemptId||f!==fence||state!=="claimed")return {ok:false,reason:"replay"}; state="dispatched";return {ok:true}; }
    },store:{
      getThread:async()=>({id:grant.threadId,project_id:grant.projectId,private:true}),
      getFiles:async()=>[{id:id(7),thread_id:grant.threadId,name:"test.png",mime:"image/png",data:bytes.toString("base64"),bytes:bytes.length}]
    },vision:{configured:true,agent:"claude",worstCaseMicros:0,analyze:async(_prompt,images)=>{calls++;assert.equal(images[0]?.sha256,grant.files[0]?.sha256);return {spec:{observed:["Blue square"],inferred:["Status card"],unknown:["Exact layout"]},actualMicros:0};}},
    commit:async(g,d)=>{assert.equal(g.goalId,d.goalId);assert.equal(state,"dispatched");assert.equal(stopped,"off");assert.equal(fence,g.fence);assert.ok(now<g.expiresAt);assert.equal(commits,0);commits++;draft=d;return {committed:true,goalId:g.goalId};}
  };
  return {p,q,grant,run:()=>createVisualGoalIntake(p)(q),draft:()=>draft,calls:()=>calls,commits:()=>commits,
    expire:()=>{now=10001},stop:()=>{stopped="on"},stale:()=>{fence=2}};
}
test("synthetic visual binding consumes one broker attempt and records only advisory text",async()=>{
  const f=fixture();const [a,b]=await Promise.all([f.run(),f.run()]);
  assert.equal([a,b].filter(x=>x.status==="recorded").length,1);
  assert.equal(f.calls(),1);assert.equal(f.commits(),1);
  assert.match(f.draft()!.title,/^\[Goal\]/);assert.match(f.draft()!.description,/Observed: Blue square/);
  assert.doesNotMatch(f.draft()!.description,/base64|aaaaaaaa|data:/);
  assert.equal((await f.run()).status,"blocked");
});
test("missing or altered authority, stale fence, cross-thread reference and unavailable vision refuse before any call",async()=>{
  for(const change of [
    (f:ReturnType<typeof fixture>)=>{f.expire()},f=>f.stop(),f=>f.stale(),
    f=>{f.p.vision.configured=false},f=>{f.p.vision.worstCaseMicros=1},
    f=>{f.grant.repository="other/app"},f=>{f.q.principal="other"},
    f=>{f.grant.files[0]!.sha256="0".repeat(64)},
    f=>{f.p.store.getThread=async()=>null},f=>{f.p.store.getFiles=async()=>[]},
    f=>{f.p.grant=async()=>null},f=>{f.p.stop=async()=> "error" as const}
  ]){
    const f=fixture();change(f);assert.equal((await f.run()).status,"blocked");assert.equal(f.calls(),0);assert.equal(f.commits(),0);
  }
  assert.equal((await createVisualGoalIntake()(fixture().q)).status,"blocked");
});
test("post-vision stop, expired authority or injected URL never creates a goal",async()=>{
  for(const change of [(f:ReturnType<typeof fixture>)=>f.stop(),f=>f.expire(),f=>f.stale()]){
    const f=fixture(),analyze=f.p.vision.analyze;f.p.vision.analyze=async(...a)=>{const r=await analyze(...a);change(f);return r;};
    assert.equal((await f.run()).status,"blocked");assert.equal(f.commits(),0);
  }
  const f=fixture();f.p.vision.analyze=async()=>({spec:{observed:["https://evil.example"],inferred:[],unknown:["unknown"]},actualMicros:0});
  assert.equal((await f.run()).status,"blocked");assert.equal(f.commits(),0);
});
