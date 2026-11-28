import { test } from "node:test";
import assert from "node:assert/strict";
import { createVisualGoalIntake } from "../src/visual-goal.ts";
import { fixture } from "./helpers/visual-goal-fixture.ts";

test("synthetic visual binding consumes one broker attempt and records only advisory text",async()=>{
  const f=fixture();const [a,b]=await Promise.all([f.run(),f.run()]);
  assert.equal([a,b].filter(x=>x.status==="recorded").length,1);
  assert.equal(f.calls(),1);assert.equal(f.commits(),1);
  assert.match(f.draft()!.title,/^\[Goal\]/);assert.match(f.draft()!.description,/Observed: Blue square/);
  assert.doesNotMatch(f.draft()!.description,/base64|aaaaaaaa|data:/);
  assert.equal((await f.run()).status,"blocked");
});
test("missing or altered authority, stale fence, cross-thread reference and unavailable vision refuse before any call",async()=>{
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f:ReturnType<typeof fixture>)=>{f.expire()},f=>f.stop(),f=>f.stale(),
    f=>{f.p.vision.configured=false},f=>{f.p.vision.worstCaseMicros=1},
    f=>{f.grant.repository="other/app"},f=>{f.q.principal="other"},
    f=>{f.grant.files[0]!.sha256="0".repeat(64)},
    f=>{f.p.store.getThread=async()=>null},f=>{f.p.store.getFiles=async()=>[]},
    f=>{f.p.grant=async()=>null},f=>{f.p.stop=async()=> "error" as const}
  ];
  for(const change of changes){
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
