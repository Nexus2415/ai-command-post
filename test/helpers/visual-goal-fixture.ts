import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createVisualGoalIntake, type VisualGrant, type VisualPorts, type GoalDraft } from "../../src/visual-goal.ts";
import type { AttemptState } from "../../src/manager.ts";

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
