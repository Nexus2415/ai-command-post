import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { SUSPENDED_AGENTS } from "../src/config.ts";

// Operations-room presentation layer (dashboard/ops-ui.js): pure helpers run in a sandbox with no DOM or fetch,
// where the script must define its helpers and touch nothing else.
const src = readFileSync(new URL("../dashboard/ops-ui.js", import.meta.url), "utf8");
const sandbox: any = {};
vm.runInNewContext(src, sandbox);
const core = sandbox.ACPOpsCore;
const post = (action: string, args: object = {}) => ({ method: "POST", body: JSON.stringify({ action, args }) });

test("the insignia's suspended list matches the engine's", () => {
  assert.deepEqual([...core.SUSPENDED], [...SUSPENDED_AGENTS]);
});

test("every AI has its own silhouette and its sub-units", () => {
  const units = ["claude", "chatgpt", "gemini", "perplexity", "codex"];
  const shapes = units.map((k) => core.SHAPES[k]);
  assert.equal(new Set(shapes).size, units.length, "shapes are distinct, so colour is never the only cue");
  for (const k of units) assert.ok(core.SUB_UNITS[k].length >= 2, k + " has sub-units");
  assert.equal(core.keyOf("<script>"), "none", "unknown keys fall back to a neutral shape");
});

test("the beacon only lights for AI work, and names the briefing phase", () => {
  assert.equal(core.describe("/api/workspace", post("get_thread", { threadId: "t" })), null);
  assert.equal(core.describe("/api/workspace", { method: "GET" }), null);
  assert.equal(core.describe("/api/console", post("chat")), null);
  assert.equal(core.describe("/api/workspace", { method: "POST", body: "not json" }), null);
  const chat = core.describe("/api/workspace", post("chat", { threadId: "t" }));
  assert.ok(chat.thread && /Waiting for the reply/.test(chat.phase));
  const cmp = core.describe("https://x.example/api/workspace?x=1", post("compare", { models: ["claude", "chatgpt", 7] }));
  assert.deepEqual([...cmp.units], ["claude", "chatgpt"]);
  assert.match(core.describe("/api/workspace", post("roundtable", { step: "start", models: ["claude"] })).phase, /Step 1 of 3 · First answers/);
  assert.match(core.describe("/api/workspace", post("roundtable", { step: "critique" })).phase, /Step 2 of 3 · Reviewing each other/);
  assert.match(core.describe("/api/workspace", post("roundtable", { step: "synthesize" })).phase, /Step 3 of 3 · Final answer/);
  assert.equal(core.describe("/api/workspace", post("roundtable", { step: "bogus" })), null);
  assert.match(core.describe("/api/intake", { method: "post", body: "{}" }).phase, /Sending your command/);
});

test("running cost comes from what the server reports", () => {
  assert.deepEqual({ ...core.costOf({ roundtableUsd: 0.031 }) }, { usd: 0.031, total: true });
  assert.equal(core.costOf({ message: { cost_usd: 0.002 } }).usd, 0.002);
  assert.equal(core.costOf({ messages: [{ cost_usd: 0.001 }, { cost_usd: "0.002" }, { cost_usd: "x" }] }).usd, 0.003);
  assert.equal(core.costOf(null).usd, 0);
  assert.equal(core.money(0.0004), "$0.0004");
  assert.equal(core.money(0.06), "$0.06");
  assert.equal(core.clock(65_000), "1:05");
});

test("both owner pages load the theme after their own styles", () => {
  for (const page of ["index.html", "workspace.html"]) {
    const html = readFileSync(new URL("../dashboard/" + page, import.meta.url), "utf8");
    const styleEnd = html.indexOf("</style>"), link = html.indexOf('href="ops-theme.css"');
    assert.ok(link > styleEnd, page + " links ops-theme.css after its inline style");
    assert.match(html, /<script src="ops-ui\.js"><\/script>/);
  }
  const css = readFileSync(new URL("../dashboard/ops-theme.css", import.meta.url), "utf8");
  assert.match(css, /\.stopbtn\{/, "the stop switch is styled to stay the most prominent control");
  assert.match(css, /prefers-reduced-motion/);
});
