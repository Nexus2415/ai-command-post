import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.match(chat, /window.ACPWork.workerAvatar\(true\)/);
  assert.match(read("workspace.html"), /work\.js/);
  assert.match(css, /\.ax-worker\.ax-typing \.ax-worker-left/);
  assert.match(css, /\.ax-worker \*\{animation:none!important\}/);
});
