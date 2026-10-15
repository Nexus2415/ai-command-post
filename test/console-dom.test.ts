// ARN-53: behavioural tests of dashboard/console.js against a tiny in-test fake DOM.
// No jsdom/happy-dom/playwright is installed, so this fake implements only what console.js touches.
// All network calls go to a scripted fake fetch; nothing reaches a real API or model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../dashboard/console.js", import.meta.url), "utf8");

class FakeEl {
  tagName: string; id = ""; className = ""; hidden = false; disabled = false; value = "";
  type = ""; href = ""; target = ""; rel = ""; tabIndex = 0;
  attrs: Record<string, string> = {}; dataset: Record<string, string> = {};
  children: any[] = []; listeners: Record<string, Function[]> = {};
  onclick: any = null; onkeydown: any = null; private _text = "";
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  get textContent(): string { return this._text + this.children.map(c => c.textContent).join(""); }
  set textContent(v: string) { this._text = String(v); this.children = []; }
  set innerHTML(_v: string) { throw new Error("innerHTML must not be used by the console"); }
  insertAdjacentHTML() { throw new Error("insertAdjacentHTML must not be used by the console"); }
  append(...n: any[]) { this.children.push(...n); }
  appendChild(n: any) { this.children.push(n); return n; }
  replaceChildren(...n: any[]) { this._text = ""; this.children = n; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(t: string, f: Function) { (this.listeners[t] ||= []).push(f); }
  focus() { doc.activeElement = this; }
  click() { return this.onclick && this.onclick({}); }
  all(): any[] { return this.children.flatMap(c => (c instanceof FakeEl ? [c, ...c.all()] : [])); }
}

let doc: any;
function setup(responses: (path: string, init: any) => any) {
  const byId: Record<string, FakeEl> = {};
  const intentBtns = ["command", "question"].map(k => { const b = new FakeEl("button"); b.dataset["intent"] = k; return b; });
  const legacy = [new FakeEl("span"), new FakeEl("section")];
  doc = {
    activeElement: null, hidden: false, listeners: {} as Record<string, Function[]>,
    getElementById: (id: string) => (byId[id] ||= Object.assign(new FakeEl("div"), { id })),
    createElement: (t: string) => new FakeEl(t),
    createTextNode: (t: string) => ({ textContent: String(t) }),
    querySelectorAll: (q: string) => (q === "#cIntent button" ? intentBtns : q === "[data-legacy]" ? legacy : []),
    addEventListener(t: string, f: Function) { (this.listeners[t] ||= []).push(f); },
    contains: () => true,
  };
  const store = new Map<string, string>([["acp.pw", "old-leaked"]]);
  const writes: [string, string][] = [];
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { writes.push([k, v]); store.set(k, v); },
    removeItem: (k: string) => store.delete(k),
  };
  const sessionWrites: any[] = [];
  const calls: { path: string; init: any; body: any }[] = [];
  const prompts: string[] = [];
  const ctx: any = {
    document: doc, localStorage,
    sessionStorage: { getItem: () => null, setItem: (...a: any[]) => sessionWrites.push(a), removeItem() {} },
    crypto: { randomUUID: (() => { let n = 0; return () => "key-" + (++n); })() },
    setInterval: () => 0, console,
    prompt: () => { prompts.push("asked"); return "s3cret"; },
    fetch: async (path: string, init: any) => {
      calls.push({ path, init, body: JSON.parse(init.body) });
      const r = await responses(path, init);
      if (r instanceof Error) throw r;
      return { status: r.status ?? 200, ok: (r.status ?? 200) < 400, json: async () => r.json ?? {} };
    },
  };
  ctx.window = ctx;
  vm.runInNewContext(src, ctx);
  ctx.ACPConsole.start();
  return { ctx, $: doc.getElementById, store, writes, sessionWrites, calls, prompts, intentBtns, legacy };
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const ok = (json: any = {}) => ({ status: 200, json });
const overviewJson = { issues: [], lanes: {}, agents: [{ key: "claude", connection: "online" }], fetchedAt: "2026-10-01T00:00:00Z" };

test("password is held in memory only: never written to localStorage or sessionStorage", async () => {
  let first = true;
  const t = setup(() => { if (first) { first = false; return { status: 401, json: { error: "unauthorized" } }; } return ok(overviewJson); });
  await flush();
  assert.equal(t.prompts.length, 1);
  assert.equal(t.calls[0]!.init.headers["x-acp-password"], "");
  assert.equal(t.calls[1]!.init.headers["x-acp-password"], "s3cret");
  assert.equal(t.store.has("acp.pw"), false, "a password left by older builds is cleared");
  assert.deepEqual(t.writes, []);
  assert.deepEqual(t.sessionWrites, []);
  t.$("cRefresh").click(); await flush();
  assert.equal(t.calls.at(-1)!.init.headers["x-acp-password"], "s3cret");
  assert.equal(t.prompts.length, 1);
});

test("double-click on Send files one intake request; button is disabled while busy", async () => {
  let release: Function = () => {};
  const t = setup(path => path === "/api/intake" ? new Promise(r => { release = () => r(ok({ identifier: "ARN-77" })); }) : ok(overviewJson));
  await flush();
  t.$("cText").value = "ship it";
  t.$("cSend").click(); t.$("cSend").click();
  await flush();
  assert.equal(t.$("cSend").disabled, true);
  // Ctrl+Enter while busy is ignored too.
  t.$("cText").listeners.keydown[0]({ key: "Enter", ctrlKey: true, preventDefault() {} });
  await flush();
  assert.equal(t.calls.filter(c => c.path === "/api/intake").length, 1);
  release(); await flush();
  assert.equal(t.$("cSend").disabled, false);
  assert.match(t.$("cSendMsg").textContent, /Command received as ARN-77/);
  assert.equal(t.$("cText").value, "");
});

test("retry of the same draft reuses its idempotency key; a new draft gets a new one", async () => {
  let fail = true;
  const t = setup(path => path === "/api/intake" ? (fail ? { status: 500, json: { error: "boom" } } : ok({ identifier: "ARN-5", duplicate: true })) : ok(overviewJson));
  await flush();
  t.$("cText").value = "do x";
  t.$("cSend").click(); await flush();
  t.$("cSend").click(); await flush();
  const intake = () => t.calls.filter(c => c.path === "/api/intake").map(c => c.body.idempotencyKey);
  assert.equal(intake()[0], intake()[1]);
  t.$("cText").value = "do y";
  t.$("cSend").click(); await flush();
  assert.notEqual(intake()[2], intake()[0]);
  fail = false; t.$("cSend").click(); await flush();
  assert.equal(intake()[3], intake()[2]);
  assert.match(t.$("cSendMsg").textContent, /already filed earlier/);
});

test("rejected requests are reported as errors, never as received", async () => {
  for (const [resp, re] of [
    [{ status: 404, json: {} }, /isn't available yet \(404\)\. Nothing was sent/],
    [{ status: 500, json: { error: "Linear down" } }, /Linear down\. Nothing was confirmed as received/],
    [new Error("offline"), /Network error/],
    [{ status: 403, json: { error: "red-tier refused" } }, /red-tier refused/],
  ] as const) {
    const t = setup(path => path === "/api/intake" ? resp : ok(overviewJson));
    await flush();
    t.$("cText").value = "x";
    t.$("cSend").click(); await flush();
    assert.match(t.$("cSendMsg").textContent, re);
    assert.equal(t.$("cSendMsg").className, "msg err");
    assert.doesNotMatch(t.$("cSendMsg").textContent, /received as/);
    assert.equal(t.$("cText").value, "x", "draft is kept for retry");
  }
  const t = setup(() => ({ status: 500, json: { error: "nope" } }));
  await flush();
  assert.match(t.$("cOverviewMsg").textContent, /nope/);
  assert.equal(t.$("cUpdated").textContent, "Not loaded");
});

test("empty text is refused locally without any request", async () => {
  const t = setup(() => ok(overviewJson));
  await flush();
  t.$("cText").value = "   ";
  t.$("cSend").click(); await flush();
  assert.equal(t.calls.filter(c => c.path === "/api/intake").length, 0);
  assert.match(t.$("cSendMsg").textContent, /Write something first/);
});

test("fixed scope: only relative /api/console (overview|thread) and /api/intake (command|question) are called", async () => {
  const t = setup((path, init) => {
    const b = JSON.parse(init.body);
    if (b.action === "thread") return ok({ issue: { id: "ARN-9", title: "t" }, comments: [] });
    return ok({ ...overviewJson, issues: [{ id: "ARN-9", lane: "active", title: "t" }], lanes: { active: ["ARN-9"] } });
  });
  await flush();
  t.$("cList").all().find((e: any) => e.className === "linkbtn")!.click(); await flush();
  t.intentBtns[1]!.click();
  assert.equal(t.$("cSend").textContent, "Ask question");
  t.$("cText").value = "why?";
  t.$("cSend").click(); await flush();
  for (const c of t.calls) {
    assert.ok(["/api/console", "/api/intake"].includes(c.path), c.path);
    assert.equal(c.init.method, "POST");
    if (c.path === "/api/console") assert.ok(["overview", "thread"].includes(c.body.action));
    else assert.deepEqual(Object.keys(c.body).sort(), ["idempotencyKey", "intent", "text"]);
  }
  const q = t.calls.find(c => c.path === "/api/intake")!.body;
  assert.equal(q.intent, "question");
  assert.equal(t.calls.find(c => c.body.action === "thread")!.body.identifier, "ARN-9");
});

test("hostile comments, titles and URLs render as inert text; only http(s) links are kept", async () => {
  const xss = '<img src=x onerror="alert(1)">';
  for (const [url, expect] of [["javascript:alert(1)", null], ["data:text/html,hi", null], ["https://linear.app/x/ARN-9", "https://linear.app/x/ARN-9"]] as const) {
    const t = setup((_p, init) => JSON.parse(init.body).action === "thread"
      ? ok({ issue: { id: "ARN-9", title: xss, url, description: xss }, comments: [{ author: xss, body: xss, createdAt: "x" }] })
      : ok({ ...overviewJson, issues: [{ id: "ARN-9", lane: "active", title: xss }] }));
    await flush();
    t.$("cList").all().find((e: any) => e.className === "linkbtn")!.click(); await flush();
    const body = t.$("cDetailBody");
    const links = body.all().filter((e: any) => e.tagName === "A");
    assert.equal(links.length ? links[0].href : null, expect);
    if (links.length) assert.equal(links[0].rel, "noopener noreferrer");
    assert.ok(body.textContent.includes(xss), "markup shown literally as text");
    assert.ok(body.all().every((e: any) => e.tagName !== "IMG"));
  }
  const t = setup(() => ok(overviewJson));
  assert.equal(t.ctx.ACPConsoleCore.safeUrl(" HTTP://a.b/c "), "HTTP://a.b/c");
  assert.equal(t.ctx.ACPConsoleCore.safeUrl("//evil.com"), null);
});

test("no fake engine-live or online claims once the console starts", async () => {
  const t = setup(() => ok(overviewJson));
  await flush();
  assert.ok(t.legacy.every(n => n.hidden), "legacy 'Engine live' chip and panels are hidden");
  const roster = t.$("cRoster").textContent;
  assert.match(roster, /Connection not verified/, "server saying 'online' is not trusted");
  assert.doesNotMatch(roster, /online|live|spend/i);
  assert.match(t.$("cIntentNote").textContent, /filed in Linear as a new command.*can't confirm/, "commands are described as filed, never as guaranteed to run");
});

test("stale thread responses don't overwrite a closed or newer thread", async () => {
  const pending: Record<string, Function> = {};
  const t = setup((_p, init) => {
    const b = JSON.parse(init.body);
    if (b.action === "thread") return new Promise(r => { pending[b.identifier] = () => r(ok({ issue: { id: b.identifier, title: "T" + b.identifier }, comments: [] })); });
    return ok({ ...overviewJson, issues: [{ id: "ARN-1", lane: "active", title: "a" }, { id: "ARN-2", lane: "active", title: "b" }] });
  });
  await flush();
  const [b1, b2] = t.$("cList").all().filter((e: any) => e.className === "linkbtn");
  b1.click(); b2.click(); await flush();
  pending["ARN-2"]!(); await flush();
  pending["ARN-1"]!(); await flush();
  assert.match(t.$("cDetailTitle").textContent, /ARN-2/);
});

test("ARN-77 malformed successful intake preserves the draft and retry key", async () => {
  for (const intent of ["command", "question"]) {
    let receipt: any = {};
    const t = setup(path => path === "/api/intake" ? ok(receipt) : ok(overviewJson));
    await flush();
    if (intent === "question") t.intentBtns[1]!.click();
    t.$("cText").value = "synthetic retry";
    for (const invalid of [{}, [], { identifier: "invalid" }, { identifier: 77 }, { id: "ARN-77" }]) {
      receipt = invalid; t.$("cSend").click(); await flush();
      assert.equal(t.$("cSendMsg").className, "msg err");
      assert.match(t.$("cSendMsg").textContent, /Nothing was confirmed as received/);
      assert.doesNotMatch(t.$("cSendMsg").textContent, /received as|Issue created|completed/i);
      assert.equal(t.$("cText").value, "synthetic retry");
    }
    const calls = () => t.calls.filter(c => c.path === "/api/intake");
    assert.equal(new Set(calls().map(c => c.body.idempotencyKey)).size, 1);
    receipt = { identifier: "ARN-77", duplicate: true }; t.$("cSend").click(); await flush();
    assert.equal(new Set(calls().map(c => c.body.idempotencyKey)).size, 1);
    assert.match(t.$("cSendMsg").textContent, /received as ARN-77.*already filed earlier/);
    assert.equal(t.$("cText").value, "");
  }
});
