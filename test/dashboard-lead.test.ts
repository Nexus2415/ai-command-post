import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { SUSPENDED_AGENTS } from "../src/config.ts";

// ARN-115: the legacy dashboard files commands straight to Linear (save_issue) without passing api/intake.js, so it
// must refuse a suspended lead on its own. Runs the page's inline script against a stub DOM and a fake Linear client.
const html = readFileSync(new URL("../dashboard/index.html", import.meta.url), "utf8");
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a loose DOM stub
type El = any;
function stubEl(): El {
  const el: El = {
    hidden: false, disabled: false, value: "", innerHTML: "", textContent: "", className: "", dataset: {}, children: [] as El[], attrs: {} as Record<string, string>,
    appendChild(c: El) { el.children.push(c); return c; },
    setAttribute(k: string, v: string) { el.attrs[k] = v; },
    querySelector: () => stubEl(), querySelectorAll: () => [], addEventListener() {}, remove() {},
  };
  return el;
}

// `patch` rewrites the page source to simulate a future code path that bypasses an earlier guard.
async function load(opts: { storedLead?: string; dbLead?: string; patch?: (src: string) => string } = {}) {
  const els = new Map<string, El>();
  const byId = (id: string) => { if (!els.has(id)) els.set(id, stubEl()); return els.get(id)!; };
  const writes: any[] = [];
  const store = new Map<string, string>(opts.storedLead ? [["acp.lead", opts.storedLead]] : []);
  const mcp = {
    callTool: async (_s: string, tool: string, args: any) => { writes.push({ tool, args }); return { payload: { identifier: "ARN-1" } }; },
    watchTool: (_s: string, tool: string, _a: unknown, cb: (ev: any) => void) => {
      if (tool === "list_teams") cb({ type: "data", result: { payload: { teams: [{ name: "Arnexyia", key: "ARN" }] } } });
      return () => {};
    },
    invalidate: async () => {},
  };
  const db = { doc: () => ({ set: async () => {}, onSnapshot: (cb: (s: any) => void) => { if (opts.dbLead) cb({ data: { agent: opts.dbLead } }); } }) };
  const window = { claude: { use: async (k: string) => (k === "mcp" ? mcp : k === "db" ? db : null) }, prompt: () => null };
  const ctx = vm.createContext({
    window, document: { getElementById: byId, createElement: () => stubEl() },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
    location: { protocol: "claude:" }, setInterval: () => 0, clearInterval: () => {}, fetch: async () => { throw new Error("no network in tests"); },
    console, Date, JSON, Object, Array, String, Number, RegExp, Promise, Set, Map, Math,
  });
  vm.runInContext(opts.patch ? opts.patch(inline) : inline, ctx);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  const leadButtons = () => byId("leadSeg").children as El[];
  async function issue(text = "Ship the thing") {
    byId("cmdText").value = text; byId("prioSel").value = "3";
    byId("issueBtn").onclick();
    if (!byId("confirmBox").hidden) await byId("confirmBtn").onclick();
    for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
  }
  return { byId, writes, store, leadButtons, issue };
}

test("dashboard pause list matches the engine's suspension list", () => {
  const m = /const PAUSED=Object\.freeze\((\[[^\]]*\])\)/.exec(inline);
  assert.ok(m, "PAUSED list present");
  assert.deepEqual(JSON.parse(m[1]!), [...SUSPENDED_AGENTS]);
});

test("a suspended agent is never offered as a lead", async () => {
  const p = await load();
  const keys = p.leadButtons().map(b => b.dataset.ag);
  assert.ok(!keys.includes("gemini"), `lead buttons: ${keys}`);
  assert.deepEqual(keys.sort(), ["chatgpt", "claude", "perplexity"]);
});

test("a stored suspended lead falls back and files under an active lead", async () => {
  const p = await load({ storedLead: "gemini" });
  await p.issue();
  assert.equal(p.writes.length, 1);
  assert.equal(p.writes[0].tool, "save_issue");
  assert.match(p.writes[0].args.title, /^\[ChatGPT\] /);
});

test("a suspended lead pushed from shared settings is ignored", async () => {
  const p = await load({ dbLead: "gemini" });
  await p.issue();
  assert.equal(p.writes.length, 1);
  assert.doesNotMatch(p.writes[0].args.title, /gemini/i);
});

test("an active lead chosen by click still files a command", async () => {
  const p = await load();
  const claude = p.leadButtons().find(b => b.dataset.ag === "claude")!;
  await claude.onclick();
  await p.issue();
  assert.equal(p.writes.length, 1);
  assert.match(p.writes[0].args.title, /^\[Claude\] /);
});

function forceLead(src: string) {
  const at = src.indexOf("renderLead(); renderRoster();\n\n// Website mode");
  assert.ok(at > 0, "init anchor present");
  return src.slice(0, at) + 'lead="gemini";\n' + src.slice(at);
}

test("the issue button refuses a suspended lead that slipped into state", async () => {
  const p = await load({ patch: forceLead });
  await p.issue();
  assert.equal(p.writes.length, 0);
  assert.match(p.byId("cmdMsg").innerHTML, /paused by the owner/);
});

test("the confirm step refuses a suspended lead even if the issue-button check is bypassed", async () => {
  const guard = 'if(!a||paused(a.key)){say("That lead AI is paused by the owner. Pick another lead.","err");return}';
  const p = await load({ patch: src => { assert.ok(src.includes(guard)); return forceLead(src.replace(guard, "")); } });
  await p.issue();
  assert.equal(p.writes.length, 0, "no Linear write");
  assert.match(p.byId("cmdMsg").innerHTML, /Nothing was sent/);
});
