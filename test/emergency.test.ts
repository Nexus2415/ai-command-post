import { test } from "node:test";
import assert from "node:assert/strict";
import { EmergencyGate, emergencyDispatch, parseEmergency } from "../src/emergency.ts";
import type { EmergencyState } from "../src/emergency.ts";

test("emergency gate defaults to denial and rejects malformed or unavailable state", async () => {
  assert.equal((await new EmergencyGate().admit()).allowed,false);
  for (const value of [null, {}, {mode:"RUN",generation:0},{mode:"RUN",generation:NaN},
    {mode:"RUN",generation:"1"},{mode:"RUN",generation:1.5},{mode:"unknown",generation:1}]) {
    assert.equal(parseEmergency(value),null);
    assert.equal((await new EmergencyGate(async()=>value).admit()).allowed,false);
  }
  assert.equal((await new EmergencyGate(async()=>{throw Error("offline")}).admit()).allowed,false);
});
test("AEGIS and BLACKOUT deny entry, recovery cannot revive a stale permit", async () => {
  let state: EmergencyState={mode:"RUN",generation:2};
  const gate=new EmergencyGate(async()=>state);
  const admission=await gate.admit();
  assert.ok(admission.allowed);
  let called=0;
  const work=async()=>{called++;return "synthetic";};
  state={mode:"AEGIS",generation:3};
  assert.deepEqual(await emergencyDispatch(gate,admission.permit,work),{status:"refused",reason:"AEGIS"});
  state={mode:"BLACKOUT",generation:4};
  assert.equal((await gate.admit()).allowed,false);
  state={mode:"RUN",generation:5};
  assert.deepEqual(await emergencyDispatch(gate,admission.permit,work),{status:"refused",reason:"emergency_generation_changed"});
  assert.equal(called,0);
  const next=await gate.admit();assert.ok(next.allowed);
  assert.deepEqual(await emergencyDispatch(gate,next.permit,work),{status:"returned",result:"synthetic"});
  assert.equal(called,1);
});
test("same-generation mode conflict or old generation refuses", async()=>{
  let state: EmergencyState={mode:"BLACKOUT",generation:8};
  const gate=new EmergencyGate(async()=>state);
  assert.equal((await gate.admit()).allowed,false);
  state={mode:"RUN",generation:8};
  assert.equal((await gate.admit()).allowed,false);
  state={mode:"RUN",generation:7};
  assert.equal((await gate.admit()).allowed,false);
});
test("emergency during execution preserves unknown, never success or automatic retry", async()=>{
  let state: EmergencyState={mode:"RUN",generation:2};
  const gate=new EmergencyGate(async()=>state);
  const a=await gate.admit();assert.ok(a.allowed);
  let called=0;
  const run=async()=>{called++;state={mode:"BLACKOUT",generation:3};return "synthetic";};
  assert.deepEqual(await emergencyDispatch(gate,a.permit,run),{status:"unknown",reason:"emergency_changed_after_dispatch"});
  assert.deepEqual(await emergencyDispatch(gate,a.permit,run),{status:"refused",reason:"BLACKOUT"});
  assert.equal(called,1);
});
test("control-plane outage at worker entry refuses even after valid admission", async()=>{
  let online=true;
  const gate=new EmergencyGate(async()=>{if(!online)throw Error("offline");return {mode:"RUN",generation:2};});
  const a=await gate.admit();assert.ok(a.allowed);online=false;
  let called=0;
  assert.equal((await emergencyDispatch(gate,a.permit,async()=>{called++;})).status,"refused");
  assert.equal(called,0);
});
