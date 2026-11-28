import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const read = (name: string) => readFileSync(new URL("../dashboard/" + name, import.meta.url), "utf8");
test("ARN-159 task selection uses local buttons and explicit external link", () => {
  const work = read("work.js");
  assert.match(work, /const a = el\("button", "ax-row"\)/);
  assert.match(work, /aria-expanded/);
  assert.match(work, /showTask\(detail, it\)/);
  assert.match(work, /action:"thread", identifier:it.id/);
  assert.match(work, /Open in Linear/);
  assert.match(work, /link.rel = "noopener noreferrer"/);
  assert.match(work, /j.issue\?\.id !== it.id/);
  assert.match(work, /Execution activity not verified/);
  assert.match(work, /host._taskRead !== token/);
  assert.match(read("command.js"), /window.ACPWork.showTask\(detail, it\)/);
  assert.match(read("command.html"), /work\.js/);
});
test("ARN-159 animation is request-bound, not an inferred live worker", () => {
  const js = read("command.js"), html = read("command.html"), css = read("nexia.css");
  assert.match(js, /dataset.reading = "true"/);
  assert.match(js, /delete \$\("orb"\).dataset.reading/);
  assert.match(js, /Execution activity unverified/);
  assert.match(html, /\.orb\[data-reading="true"\]::before/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /\.ax-task-detail\[hidden\]/);
});

test("ARN-159 compact avatar never implies execution from task lane", () => {
  const work = read("work.js"), css = read("nexia.css"), chat = read("workspace.js");
  assert.match(work, /function workerAvatar\(typing = false\)/);
  assert.match(work, /ico.append\(workerAvatar\(false\)\)/);
  assert.match(work, /Live activity unverified/);
  assert.doesNotMatch(work, /workerAvatar\(true\)/);
  assert.match(work, /classList.toggle\("ax-typing", live\)/);
  assert.match(chat, /window.ACPWork.workerAvatar\(true\)/);
  assert.match(read("workspace.html"), /work\.js/);
  assert.match(css, /\.ax-worker\.ax-typing \.ax-worker-left/);
  assert.match(css, /\.ax-worker \*\{animation:none!important\}/);
});

test("ARN-159 actual task motion requires an exact fresh admitted heartbeat", () => {
  const ctx: any = {};
  runInNewContext(read("live-activity.js"), ctx);
  runInNewContext(read("work.js"), ctx);
  const now = Date.parse("2026-11-28T12:00:00Z");
  const it = {id:"ARN-159",lane:"active"};
  const agent = {state:"working",issue:it.id,issues:[it.id,"ARN-160"],at:new Date(now-1000).toISOString()};
  const report = {status:"reported",readAt:new Date(now).toISOString(),ttlMs:240000,agents:{claude:agent}};
  const live = (a: unknown, item = it, time = now) => ctx.ACPWork.taskLive(a,item,time);
  assert.equal(live(report),true);
  assert.equal(live(report,{...it,id:"ARN-160"}),false,"aggregate task IDs cannot inherit another task's timestamp");
  assert.equal(live(report,{...it,lane:"done"}),false);
  assert.equal(live(report,it,now+240001),false);
  assert.equal(live({...report,status:"incomplete"}),false);
  assert.equal(live({...report,readAt:new Date(now+1).toISOString()}),false);
  assert.equal(live({...report,agents:{claude:{...agent,at:new Date(now+1).toISOString()}}}),false);
  assert.equal(live({...report,agents:{claude:{...agent,state:"blocked"}}}),false);
  assert.equal(live({...report,agents:{gemini:agent}}),false);
  assert.equal(live(null),false);
});
