import { test } from "node:test";
import assert from "node:assert/strict";
import { makePerplexityHandoff, startPerplexityComputer, PERPLEXITY_CONNECTION } from "../src/perplexity-computer-connector.mjs";
const input = {issue:"ARN-64",taskText:"Research safe triggers",workspaceId:"workspace-1",projectId:"project-1",originCommentId:"comment-1",assignmentRevision:1,acceptanceCriteria:"Return official sources",dataClassification:"synthetic-or-public"};
test("preserves question, metadata and honest pre-admission status",()=>{
 const a=makePerplexityHandoff(input),b=makePerplexityHandoff({...input,taskText:"Another question",assignmentRevision:2});
 assert.equal(a.ok,true);assert.equal(a.schemaVersion,1);
 assert.equal(a.taskText,input.taskText);assert.equal(a.acceptanceCriteria,input.acceptanceCriteria);
 assert.equal(a.status,"payload-packaged-not-admitted");assert.equal(a.admitted,false);assert.equal(a.claimed,false);
 assert.equal(a.issueUrl,"https://linear.app/arnexyia/issue/arn-64");
 assert.notEqual(a.assignmentKey,b.assignmentKey);assert.notEqual(a.taskText,b.taskText);
 assert.equal(a.outputDestination,"same-linear-issue");assert.equal(a.eventReceiptId,null);
});
test("repeated delivery preserves canonical assignment but distinct receipts",()=>{
 const a=makePerplexityHandoff({...input,eventReceiptId:"event-1"});
 const b=makePerplexityHandoff({...input,eventReceiptId:"event-2"});
 assert.equal(a.assignmentKey,b.assignmentKey);assert.notEqual(a.eventReceiptId,b.eventReceiptId);
 assert.equal(a.claimed,false);
});
test("rejects coerced ids, client classifications and unsupported controls",()=>{
 const bad=[{issue:{toString:()=>"ARN-64"}},{issue:"OTHER-7"},{issue:"ARN-0"},{issue:0},{taskText:""},{taskText:"x".repeat(4001)},{projectId:null},{originCommentId:"bad/value"},{assignmentRevision:0},{assignmentRevision:1.2},{acceptanceCriteria:""},{eventReceiptId:[]},{authorityOverride:true},{dataClassification:"client"}];
 for(const item of bad) assert.equal(makePerplexityHandoff({...input,...item}).ok,false,Object.keys(item)[0]);
});
test("never remotely executes even with supplied activation hints",async()=>{
 for(const opts of [{},{enabled:true,apiKey:"synthetic"},{paidApproved:true},{nativeAutomationReady:true}]) {
  const a=await startPerplexityComputer(makePerplexityHandoff(input),opts);
  assert.equal(a.status,"unsupported");assert.equal(a.retry,false);assert.equal(a.remoteExecutionReady,false);
 }
 assert.equal(PERPLEXITY_CONNECTION.paidApiAuthorized,false);
 assert.equal(PERPLEXITY_CONNECTION.remoteExecutionReady,false);
});
