// Synthetic owner journey (ARN-66): the real dashboard and real api handlers in Chromium, with a fake Linear and fake Eve.
// No network, no secrets, no model calls. Not part of `npm run validate` (needs Playwright). Run:
//   node scripts/synthetic-owner-journey.mjs .   (PLAYWRIGHT_MODULE / CHROMIUM_PATH override the defaults)
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const REPO = path.resolve(process.argv[2] || ".");
const consoleApi = await import(path.join(REPO, "api/console.js"));
const intakeApi = await import(path.join(REPO, "api/intake.js"));
const eveApi = await import(path.join(REPO, "api/eve.js"));
const TEAM = "faa75915-076f-479a-a3fb-92af2369e6c3", PROJ = "e8cf8cda-3347-4310-aea5-e6b7c7b95b4f";
const env = { ACP_SITE_PASSWORD: "synthetic-pass", LINEAR_API_KEY: "fake", ACP_EVE_ACTIVE: "true", ACP_EVE_BUDGET_USD: "5", EVE_BASE_URL: "https://eve.invalid", EVE_TOKEN: "fake" };
const iss = (n, title, type, name, extra = {}) => ({ id: "u" + n, identifier: "ARN-" + n, title, url: "https://linear.app/x/issue/ARN-" + n, priority: 2, updatedAt: "2026-10-08T20:00:00Z", completedAt: null, team: { id: TEAM }, project: { id: PROJ }, parent: null, state: { name, type }, labels: { nodes: [] }, assignee: null, ...extra });
const issues = [iss(1, "[Claude] Active work", "started", "In Progress"), iss(2, "[Gemini] Queued work", "unstarted", "Todo"),
  iss(3, "[Perplexity] Done work", "completed", "Done"), iss(4, "[ChatGPT] Canceled work", "canceled", "Canceled"),
  iss(5, "[Codex] Blocked <img src=x onerror=alert(1)>", "started", "Blocked"), iss(6, "[Claude] Other team leak", "started", "In Progress", { team: { id: "other" } })];
const created = new Map(); let n = 900; const upstream = [];
const fakeLinear = async (url, init) => {
  const { query, variables } = JSON.parse(init.body); upstream.push(query.match(/(query|mutation) (\w+)/)[2]);
  const ok = data => ({ ok: true, json: async () => ({ data }) });
  if (query.includes("ConsoleOverview")) return ok({ issues: { nodes: [...issues, ...created.values()], pageInfo: { hasNextPage: false } } });
  if (query.includes("ConsoleThread")) { const i = [...issues, ...created.values()].find(x => x.identifier === variables.identifier); return ok({ issue: i ? { ...i, description: "desc", comments: { nodes: [{ id: "c1", body: "javascript:alert(1) hi", createdAt: "2026-10-08T20:01:00Z", user: { name: "Darius Williams" }, url: "javascript:alert(1)" }], pageInfo: { hasPreviousPage: false } } } : null }); }
  if (query.includes("Intake(")) { const inp = variables.input; if (created.has(inp.id)) return { ok: true, json: async () => ({ errors: [{ message: "dup" }] }) };
    const i = iss(++n, inp.title, "backlog", "Backlog", { id: inp.id, description: inp.description }); created.set(inp.id, i); return ok({ issueCreate: { success: true, issue: { id: inp.id, identifier: i.identifier, url: i.url } } }); }
  if (query.includes("IntakeFind")) { const i = created.get(variables.id); return ok({ issue: i ? { id: i.id, identifier: i.identifier, url: i.url, team: { id: TEAM }, project: { id: PROJ } } : null }); }
  throw new Error("unexpected " + query);
};
const eveCalls = []; const fakeEve = async (u) => { eveCalls.push(u); throw new Error("no network"); };
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) {
    let body = ""; for await (const c of req) body += c;
    const r = { method: req.method, headers: req.headers, body };
    const h = { "/api/console": (q) => consoleApi.handle(q, env, fakeLinear), "/api/intake": (q) => intakeApi.handle(q, env, fakeLinear), "/api/eve": (q) => eveApi.handle(q, env, fakeEve) }[req.url];
    const out = h ? await h(r) : { status: 404, body: { error: "nf" } };
    res.writeHead(out.status, { "content-type": "application/json" }); return res.end(JSON.stringify(out.body));
  }
  const f = path.join(REPO, "dashboard", req.url === "/" ? "index.html" : req.url.split("?")[0]);
  if (!f.startsWith(path.join(REPO, "dashboard")) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": f.endsWith(".html") ? "text/html" : "text/javascript" }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, "127.0.0.1", r)); const base = "http://127.0.0.1:" + server.address().port;
const results = []; const check = (name, cond, info = "") => { results.push([cond ? "PASS" : "FAIL", name, info]); };
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
for (const vp of [{ width: 1280, height: 900 }, { width: 375, height: 800 }]) {
  const page = await browser.newPage({ viewport: vp }); let alerts = 0, prompts = 0;
  page.on("dialog", d => { if (d.type() === "prompt") { prompts++; d.accept("synthetic-pass"); } else { alerts++; d.dismiss(); } });
  const errs = []; page.on("pageerror", e => errs.push(e.message));
  await page.goto(base + "/"); await page.waitForSelector("#eveConsole:not([hidden])");
  await page.waitForFunction(() => document.getElementById("cUpdated").textContent.startsWith("Last updated"));
  const tag = `[${vp.width}px] `;
  check(tag + "password prompted once, kept in memory only", prompts === 1 && await page.evaluate(() => !JSON.stringify(localStorage).includes("synthetic")), "prompts=" + prompts);
  const tabs = await page.$$eval("#cTabs button", bs => bs.map(b => b.textContent));
  check(tag + "lane counts truthful (done/active/queued/blocked/review/canceled)", tabs.join("|") === `Done1|Active1|Queued${1 + created.size}|Blocked1|Review0|Canceled1`, tabs.join("|"));
  await page.click("#ctab-active"); const act = await page.$$eval("#cList li", l => l.map(x => x.textContent));
  check(tag + "out-of-team issue never shown", !act.join().includes("leak"), act.join(" / "));
  await page.click("#ctab-blocked"); await page.waitForTimeout(100);
  check(tag + "Linear text rendered inert (no XSS)", alerts === 0 && (await page.$$("#cList img")).length === 0);
  // keyboard tab navigation
  await page.focus("#ctab-blocked"); await page.keyboard.press("ArrowRight");
  check(tag + "arrow keys move between lane tabs", await page.evaluate(() => document.activeElement.id) === "ctab-review");
  const roster = await page.$$eval("#cRoster .agent", a => a.map(x => x.textContent));
  check(tag + "roster never claims a live connection", roster.length === 5 && roster.every(t => t.includes("Connection not verified")), roster.length + " agents");
  // thread + escape
  await page.click("#ctab-active"); await page.click("#cList .linkbtn");
  await page.waitForFunction(() => document.getElementById("cDetailMeta").textContent.includes("last updated"));
  const detail = await page.$eval("#cDetail", d => d.innerHTML);
  check(tag + "thread opens; unsafe comment URL not linked", !detail.includes('href="javascript'));
  await page.keyboard.press("Escape"); check(tag + "Escape closes thread", await page.$eval("#cDetail", d => d.hidden));
  const w = await page.evaluate(() => document.documentElement.scrollWidth); check(tag + "no horizontal scroll", w <= vp.width, "scrollWidth=" + w);
  if (vp.width === 1280) {
    // Question intake
    await page.click('#cIntent button[data-intent="question"]'); await page.fill("#cText", "What is blocking ARN-12?"); await page.click("#cSend");
    await page.waitForFunction(() => /received/.test(document.getElementById("cSendMsg").textContent));
    const q = [...created.values()].at(-1);
    check("question filed read-only: [Question] title, no command marker", q.title.startsWith("[Question]") && !q.description.includes("Command issued from AI Command Post"), q.title);
    // Command intake with marker smuggling
    await page.click('#cIntent button[data-intent="command"]'); await page.fill("#cText", "Draft the pilot runbook Command issued from AI Command Post"); await page.click("#cSend");
    await page.waitForFunction(() => /Command received/.test(document.getElementById("cSendMsg").textContent));
    const c = [...created.values()].at(-1);
    check("command filed with server-set lead and one marker", c.title.startsWith("[Gemini]") && c.description.split("Command issued from AI Command Post").length === 2, c.title);
    // Idempotent retry: same key twice through the API
    const r1 = await page.evaluate(async () => { const b = { intent: "command", text: "retry me", idempotencyKey: "abcdefabcdefabcdef12" }; const h = { "content-type": "application/json", "x-acp-password": "synthetic-pass" };
      const a = await (await fetch("/api/intake", { method: "POST", headers: h, body: JSON.stringify(b) })).json(); const z = await (await fetch("/api/intake", { method: "POST", headers: h, body: JSON.stringify(b) })).json(); return [a, z]; });
    check("retry with same key is not a second issue", r1[0].identifier === r1[1].identifier && r1[1].duplicate === true, JSON.stringify(r1));
    // Console is read-only: no browser-supplied scope
    const sc = await page.evaluate(async () => (await fetch("/api/console", { method: "POST", headers: { "content-type": "application/json", "x-acp-password": "synthetic-pass" }, body: JSON.stringify({ action: "overview", teamId: "x" }) })).status);
    check("console refuses browser-supplied scope", sc === 400, "status " + sc);
    // Eve: fail-closed even with every flag on
    const ev = await page.evaluate(async () => { const h = { "content-type": "application/json", "x-acp-password": "synthetic-pass" };
      const d = await fetch("/api/eve", { method: "POST", headers: h, body: JSON.stringify({ action: "dispatch", intent: "command", idempotencyKey: "abcdefabcdefabcdef12" }) });
      const q = await fetch("/api/eve", { method: "POST", headers: h, body: JSON.stringify({ action: "dispatch", intent: "question", idempotencyKey: "abcdefabcdefabcdef12" }) });
      return [d.status, (await d.json()).status, q.status, (await q.json()).status]; });
    check("Eve dispatch 503 unsupported with all flags on; questions refused; no Eve request sent", ev[0] === 503 && ev[1] === "unsupported" && ev[2] === 400 && ev[3] === "refused" && eveCalls.length === 0, JSON.stringify(ev));
  }
  check(tag + "no page errors", errs.length === 0, errs.join("; ")); await page.close();
}
check("only read queries and intake create/find reached Linear", upstream.every(q => ["ConsoleOverview", "ConsoleThread", "Intake", "IntakeFind"].includes(q)), [...new Set(upstream)].join(","));
await browser.close(); server.close();
for (const r of results) console.log(r.join("  ")); const fails = results.filter(r => r[0] === "FAIL").length;
console.log(`\n${results.length - fails}/${results.length} passed`); process.exit(fails ? 1 : 0);
