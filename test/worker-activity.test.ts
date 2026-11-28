import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as wa from "../api/_lib/worker-activity.js";
const { HEARTBEAT_TTL_MS, LEASE_MS, RECENT_MS } = wa;
const projectActivity = (x: any): any => wa.projectActivity(x);
const readActivity = (env: any, f: any, now: number): Promise<any> => wa.readActivity(env, f, now);
const { ROW_LIMIT, CLAIM_LIMIT } = wa;
import { handle } from "../api/console.js";
import { activitySinkFrom, memoryActivity, supabaseActivity } from "../src/activity.ts";
import { memoryClaims } from "../src/claims.ts";
import { Budget, DEFAULT_RATES } from "../src/budget.ts";
import { loadConfig, type AgentKey } from "../src/config.ts";
import type { Issue, StateType, TaskStore } from "../src/linear.ts";
import { tick, type Deps } from "../src/orchestrator.ts";
import type { ModelClient } from "../src/providers.ts";
import { STOPPED } from "../src/stop-switch.ts";

// ARN-163: the Team map avatars move only on verified live work. Synthetic rows and fakes only.
const NOW = Date.parse("2026-11-28T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const claim = (issue: string, executor: string, run: string, msAgo = 60_000) => ({ issue_id: issue, executor, run_id: run, claimed_at: iso(msAgo) });
let seqs = new Map<string, number>();
function row(kind: string, msAgo: number, o: { issue?: string; ident?: string; agent?: string; run?: string; seq?: number; step?: number | null } = {}) {
  const issue = o.issue ?? "iss-1", run = o.run ?? "run-a", k = run + issue;
  const seq = o.seq ?? (seqs.get(k) ?? 0) + 1;
  seqs.set(k, Math.max(seq, seqs.get(k) ?? 0));
  return { run_id: run, issue_id: issue, seq, identifier: o.ident ?? "ARN-12", executor: "acp:" + (o.agent ?? "claude"), kind, step: o.step ?? (kind === "step" ? seq - 1 : null), at: iso(msAgo) };
}
const project = (rows: any[], claims: any[], ok = true): any => projectActivity({ ok, rows, claims, nowMs: NOW }).agents;
test.beforeEach(() => { seqs = new Map(); });

// ---------- the five states ----------

test("working: a fresh heartbeat from the run that holds the claim", () => {
  const a = project([row("started", 90_000), row("step", 80_000), row("step", 20_000)], [claim("iss-1", "acp:claude", "run-a", 95_000)]);
  assert.equal(a.claude.state, "working");
  assert.equal(a.claude.issue, "ARN-12");
  assert.equal(a.claude.step, 2);
  assert.deepEqual(a.claude.issues, ["ARN-12"]);
  assert.equal(a.chatgpt.state, "idle", "no rows for another AI: idle, not working");
});

test("idle: a readable store with no recent runs; a released task is idle too", () => {
  assert.deepEqual(Object.values(project([], [])).map((a: any) => a.state), ["idle", "idle", "idle", "idle"]);
  const a = project([row("started", 50_000), row("step", 40_000), row("released", 30_000)], [claim("iss-1", "acp:claude", "run-a")]);
  assert.equal(a.claude.state, "idle");
  const old = project([row("started", RECENT_MS + 60_000), row("done", RECENT_MS + 30_000)], [claim("iss-1", "acp:claude", "run-a", RECENT_MS + 70_000)]);
  assert.equal(old.claude.state, "idle", "a finish older than the recent window fades back to idle");
});

test("blocked and completed come only from a terminal row; Stop everything reads as stopped", () => {
  const c = project([row("started", 50_000), row("step", 40_000), row("done", 30_000)], [claim("iss-1", "acp:claude", "run-a")]);
  assert.equal(c.claude.state, "completed");
  assert.equal(c.claude.issue, "ARN-12");
  const b = project([row("started", 50_000), row("blocked", 30_000)], [claim("iss-1", "acp:claude", "run-a")]);
  assert.equal(b.claude.state, "blocked");
  assert.equal(b.claude.stopped, undefined);
  const k = project([row("started", 50_000), row("step", 40_000), row("stopped", 30_000)], [claim("iss-1", "acp:claude", "run-a")]);
  assert.equal(k.claude.state, "blocked");
  assert.equal(k.claude.stopped, true, "the kill switch is shown as stopped, never as working");
});

test("unknown: read failure, missing lists, and a run that went quiet without a result", () => {
  for (const a of [project([], [], false), projectActivity({ ok: true, rows: null, claims: [], nowMs: NOW }).agents]) {
    assert.deepEqual(Object.values(a).map((x: any) => x.state), ["unknown", "unknown", "unknown", "unknown"]);
  }
  const quiet = project([row("started", HEARTBEAT_TTL_MS + 120_000), row("step", HEARTBEAT_TTL_MS + 60_000)], [claim("iss-1", "acp:claude", "run-a", HEARTBEAT_TTL_MS + 130_000)]);
  assert.equal(quiet.claude.state, "unknown");
  assert.match(quiet.claude.reason, /quiet/);
});

// ---------- fences, ordering and time ----------

test("late, duplicate and out-of-order rows: a terminal row beats any heartbeat", () => {
  const claims = [claim("iss-1", "acp:claude", "run-a")];
  // Delivered out of order, a replayed heartbeat after done, and an exact duplicate.
  const rows = [row("done", 30_000, { seq: 3 }), row("step", 5_000, { seq: 4, step: 2 }), row("started", 60_000, { seq: 1 }), row("step", 50_000, { seq: 2, step: 1 })];
  rows.push({ ...rows[0]! });
  const a = project(rows, claims);
  assert.equal(a.claude.state, "completed", "a later heartbeat never revives a finished run");
  const conflict = project([row("started", 60_000, { seq: 1 }), row("step", 10_000, { seq: 2 }), { ...row("done", 10_000, { seq: 2 }) }], claims);
  assert.equal(conflict.claude.state, "unknown", "two different rows with one sequence number can't both be true");
});

test("mismatched fence: rows from a run that lost the claim, or from another AI, are ignored", () => {
  const rows = [row("started", 40_000, { run: "run-old" }), row("step", 10_000, { run: "run-old" })];
  // The old run's rows are fenced out; the new run holds a live claim but wrote nothing, so that is unknown, not idle.
  const moved = project(rows, [claim("iss-1", "acp:claude", "run-new")]);
  assert.equal(moved.claude.state, "unknown", "old run fenced out, new claim unseen");
  assert.match(moved.claude.reason, /claimed but no activity/);
  const other = project(rows, [claim("iss-1", "acp:chatgpt", "run-old")]);
  assert.equal(other.claude.state, "idle", "claim held as another AI: Claude's rows don't count");
  assert.equal(other.chatgpt.state, "unknown", "and ChatGPT holds a live claim with no rows of its own");
  assert.equal(project(rows, []).claude.state, "idle", "no claim at all");
  const p = projectActivity({ ok: true, rows, claims: [claim("iss-1", "acp:claude", "run-new")], nowMs: NOW });
  assert.equal(p.dropped, 2);
});

test("stale and future time: aged heartbeats and expired leases are not live; future rows are dropped", () => {
  const stale = project([row("started", HEARTBEAT_TTL_MS + 5_000), row("step", HEARTBEAT_TTL_MS + 1_000)], [claim("iss-1", "acp:claude", "run-a", HEARTBEAT_TTL_MS + 6_000)]);
  assert.equal(stale.claude.state, "unknown");
  const lease = project([row("started", 30_000), row("step", 10_000)], [claim("iss-1", "acp:claude", "run-a", LEASE_MS + 1_000)]);
  assert.equal(lease.claude.state, "unknown", "fresh rows under a claim older than the engine's lease can't be a live run");
  const future = projectActivity({ ok: true, rows: [row("started", -5 * 60_000), row("step", -6 * 60_000)], claims: [claim("iss-1", "acp:claude", "run-a", LEASE_MS + 60_000)], nowMs: NOW });
  assert.equal(future.dropped, 2, "rows dated in the future are not trusted");
  assert.equal(future.agents.claude.state, "idle");
});

test("malformed rows are dropped, never guessed into a state", () => {
  const claims = [claim("iss-1", "acp:claude", "run-a")];
  const bad = [
    { ...row("step", 10_000), kind: "working" }, { ...row("step", 10_000), seq: 0 }, { ...row("step", 10_000), at: "soon" },
    { ...row("step", 10_000), executor: "acp:eve" }, { ...row("step", 10_000), identifier: "<b>x</b>" }, { ...row("step", 10_000), issue_id: "a,b" }, null, "row",
  ];
  const p = projectActivity({ ok: true, rows: bad, claims, nowMs: NOW });
  assert.equal(p.agents.claude.state, "unknown", "a live claim whose rows are all unreadable is unknown");
  assert.equal(p.dropped, bad.length);
});

test("several tasks: any live run makes the AI working, newest first", () => {
  const rows = [
    row("started", 60_000, { issue: "iss-1", ident: "ARN-1" }), row("done", 50_000, { issue: "iss-1", ident: "ARN-1" }),
    row("started", 40_000, { issue: "iss-2", ident: "ARN-2" }), row("step", 15_000, { issue: "iss-2", ident: "ARN-2" }),
  ];
  const a = project(rows, [claim("iss-1", "acp:claude", "run-a"), claim("iss-2", "acp:claude", "run-a")]);
  assert.equal(a.claude.state, "working");
  assert.equal(a.claude.issue, "ARN-2");
});

// ---------- reading from the database ----------

const DB = { ACP_WORKSPACE_DB_URL: "https://x.supabase.co", ACP_WORKSPACE_DB_KEY: "service-test" };
function fakeDb(rows: any[], claims: any[], fail?: "activity" | "claims" | "throw") {
  const seen: string[] = [];
  const f = (async (url: any, init: any) => {
    const u = String(url); seen.push(init.method + " " + u);
    if (fail === "throw") throw new Error("network down");
    if (u.includes("/acp_activity")) return fail === "activity" ? new Response('{"message":"relation does not exist"}', { status: 404 }) : Response.json(rows);
    if (u.includes("/acp_claims")) return fail === "claims" ? new Response("{}", { status: 500 }) : Response.json(claims);
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { f, seen };
}

test("readActivity: claims, then rows, then claims again, by time, with GETs only", async () => {
  const db = fakeDb([row("started", 40_000), row("step", 10_000)], [claim("iss-1", "acp:claude", "run-a")]);
  const r = await readActivity(DB, db.f, NOW);
  assert.equal(r.status, "reported");
  assert.equal(r.agents.claude.state, "working");
  assert.equal(r.readAt, new Date(NOW).toISOString());
  assert.equal(r.ttlMs, HEARTBEAT_TTL_MS);
  assert.ok(db.seen.every(s => s.startsWith("GET ")), "read-only");
  assert.equal(db.seen.length, 3);
  assert.match(db.seen[0]!, /acp_claims\?select=issue_id,executor,run_id,claimed_at&claimed_at=gte\.[^&]+&order=claimed_at\.desc&limit=1000$/);
  assert.match(db.seen[1]!, /acp_activity\?select=run_id,issue_id,seq,identifier,executor,kind,step,at&at=gte\.[^&]+&order=at\.desc&limit=1000$/);
  assert.equal(db.seen[2], db.seen[0]);
});

test("readActivity outage: missing table, failing claims read, network error or no database all read unknown", async () => {
  for (const fail of ["activity", "claims", "throw"] as const) {
    const r = await readActivity(DB, fakeDb([row("step", 10_000)], [claim("iss-1", "acp:claude", "run-a")], fail).f, NOW);
    assert.equal(r.status, "unavailable", fail);
    assert.deepEqual(Object.values(r.agents).map((a: any) => a.state), ["unknown", "unknown", "unknown", "unknown"]);
  }
  const none = await readActivity({}, (async () => { throw new Error("must not be called"); }) as any, NOW);
  assert.equal(none.status, "unconfigured");
  assert.equal(none.agents.claude.state, "unknown");
  const http = await readActivity({ ...DB, ACP_WORKSPACE_DB_URL: "http://x.supabase.co" }, (async () => { throw new Error("must not be called"); }) as any, NOW);
  assert.equal(http.status, "unconfigured", "a non-https database is never sent the key");
});

test("console overview carries the activity report beside the board, and its failure never hides the board", async () => {
  const env = { ACP_SITE_PASSWORD: "pw", LINEAR_API_KEY: "lin", ...DB };
  const req = { method: "POST", headers: { "x-acp-password": "pw" }, body: { action: "overview" } };
  const linear = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("supabase")) throw new Error("db down");
    const q = JSON.parse(init.body).query as string;
    if (q.includes("ConsoleEngineStatus")) return Response.json({ data: { project: { documents: { nodes: [], pageInfo: { hasNextPage: false } } } } });
    return Response.json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } });
  }) as typeof fetch;
  const r: any = await handle(req, env, linear, () => new Date(NOW));
  assert.equal(r.status, 200);
  assert.equal(r.body.activity.status, "unavailable");
  assert.equal(r.body.activity.agents.claude.state, "unknown");
  assert.ok(Array.isArray(r.body.issues), "board still loads");
});

// ---------- the engine writes the rows ----------

class Store implements TaskStore {
  issues: Issue[] = [];
  comments = new Map<string, { body: string; createdAt: string }[]>();
  add(p: Partial<Issue> & { title: string }): Issue {
    const n = this.issues.length + 1;
    const i: Issue = { id: `i${n}`, identifier: `ARN-${n}`, description: "", url: "", priority: 3, stateType: "unstarted", stateName: "Todo",
      labels: [], assignee: null, parentId: null, childIds: [], createdAt: new Date(2026, 9, 1, 0, n).toISOString(), ...p };
    this.issues.push(i); return i;
  }
  async listOpenAndRecent() { return this.issues.map(i => ({ ...i, childIds: [...i.childIds] })); }
  async getComments(id: string) { return this.comments.get(id) ?? []; }
  async createIssue(input: { title: string; description: string; parentId?: string }) { return this.add({ title: input.title, description: input.description, parentId: input.parentId ?? null }); }
  async comment(id: string, body: string) { const l = this.comments.get(id) ?? []; l.push({ body, createdAt: new Date().toISOString() }); this.comments.set(id, l); }
  async setState(id: string, _t: string, type: StateType) { this.issues.find(i => i.id === id)!.stateType = type; }
}
const scripted = (replies: string[]): ModelClient => ({ async chat() { const text = replies.shift(); if (text === undefined) throw new Error("no reply"); return { text, inputTokens: 10, outputTokens: 5 }; } });
const RATES = { ...DEFAULT_RATES, chatgpt: { inputPerM: 0, outputPerM: 0, freeTier: true } };
function deps(store: Store, clients: Partial<Record<AgentKey, ModelClient>>, extra: Partial<Deps> = {}): Deps {
  const cfg = loadConfig({ ACP_ACTIVE: "true", ACP_DRY_RUN: "false" });
  return { cfg, store, clients, budget: new Budget({ capUsd: 0, path: null, rates: RATES }),
    toolEnv: (issue) => ({ dryRun: false, policy: { allowPullRequests: false, allowedRepos: [] }, comment: (b) => store.comment(issue.id, `TOOL: ${b}`), requestApproval: async () => {} }),
    ...extra };
}
const DONE = JSON.stringify({ final: "ok", status: "done" });
const BLOCKED = JSON.stringify({ final: "can't", status: "blocked" });
const TOOL = JSON.stringify({ tool: "linear.comment", input: { body: "note" } });
const kinds = (a: { events: { kind: string }[] }) => a.events.map(e => e.kind).join(",");

test("engine: a worked task writes started, a heartbeat per reply and one done, fenced by the claim's run id", async () => {
  const store = new Store();
  store.add({ title: "[ChatGPT] check docs" });
  const claims = memoryClaims();
  const activity = memoryActivity(claims.runId!);
  await tick(deps(store, { chatgpt: scripted([TOOL, DONE]) }, { claims, activity }));
  assert.equal(kinds(activity), "started,step,step,done");
  assert.deepEqual(activity.events.map(e => e.seq), [1, 2, 3, 4]);
  assert.deepEqual(activity.events.map(e => e.step), [null, 1, 2, null]);
  assert.ok(activity.events.every(e => e.executor === "acp:chatgpt" && e.runId === claims.runId && e.identifier === "ARN-1"));
  // The site's projection agrees once the run's rows and claim are read back.
  const rows = activity.events.map(e => ({ run_id: e.runId, issue_id: e.issueId, seq: e.seq, identifier: e.identifier, executor: e.executor, kind: e.kind, step: e.step, at: e.at }));
  const held = [...claims.rows].map(([id, r]) => ({ issue_id: id, executor: r.executor, run_id: r.run, claimed_at: new Date(r.at).toISOString() }));
  assert.equal(projectActivity({ ok: true, rows, claims: held, nowMs: Date.now() }).agents.chatgpt.state, "completed");
});

test("engine: blocked, stopped and returned tasks each end with their own terminal row", async () => {
  {
    const store = new Store(); store.add({ title: "[ChatGPT] check docs" });
    const activity = memoryActivity("run-x");
    await tick(deps(store, { chatgpt: scripted([BLOCKED]) }, { activity }));
    assert.equal(kinds(activity), "started,step,blocked");
  }
  {
    // Stop everything pressed after a tool ran: the next model call is refused and the row says stopped.
    const store = new Store(); store.add({ title: "[ChatGPT] check docs" });
    const activity = memoryActivity("run-x");
    let checks = 0;
    await tick(deps(store, { chatgpt: scripted([TOOL, DONE]) }, { activity, halt: async () => (++checks <= 3 ? null : STOPPED) }));
    assert.equal(kinds(activity), "started,step,stopped", "the refused call never counts as a heartbeat");
  }
  {
    // A transient provider failure before any tool ran returns the task to Todo: released, which reads idle.
    const store = new Store(); store.add({ title: "[ChatGPT] check docs" });
    const activity = memoryActivity("run-x");
    await tick(deps(store, { chatgpt: { async chat() { throw new Error("socket hang up"); } } }, { activity }));
    assert.equal(kinds(activity), "started,step,released");
  }
});

test("engine: no row before the claim is held, and a lost claim writes nothing", async () => {
  const store = new Store(); store.add({ title: "[ChatGPT] check docs" });
  const rows = new Map();
  const first = memoryClaims(rows);
  await first.acquire("i1", "acp:claude"); // another AI already holds it
  const activity = memoryActivity("run-y");
  await tick(deps(store, { chatgpt: scripted([DONE]) }, { claims: memoryClaims(rows), activity }));
  assert.equal(activity.events.length, 0);
});

test("sink: a failing telemetry write never stops the task and is logged once", async () => {
  const logs: string[] = [];
  const posts: any[] = [];
  const f = (async (url: any, init: any) => { posts.push({ url: String(url), init }); return new Response("{}", { status: 404 }); }) as typeof fetch;
  const sink = supabaseActivity("https://x.supabase.co/", "service", "run-z", f, () => NOW, l => logs.push(l));
  const store = new Store(); store.add({ title: "[ChatGPT] check docs" });
  await tick(deps(store, { chatgpt: scripted([DONE]) }, { activity: sink }));
  assert.equal(store.issues[0]!.stateType, "completed", "work finished despite telemetry failing");
  assert.equal(logs.filter(l => l.includes("activity telemetry not written")).length, 1);
  assert.equal(posts[0]!.url, "https://x.supabase.co/rest/v1/acp_activity?on_conflict=run_id,issue_id,seq");
  assert.equal(posts[0]!.init.headers.prefer, "resolution=ignore-duplicates,return=minimal");
  assert.deepEqual(Object.keys(JSON.parse(posts[0]!.init.body)).sort(), ["at", "executor", "identifier", "issue_id", "kind", "run_id", "seq", "step"]);
  assert.equal(activitySinkFrom(DB, undefined), undefined, "no run id, no sink: rows must always carry the fence");
  assert.equal(activitySinkFrom({}, "run"), undefined);
});

// ---------- the Team map view ----------

const src = readFileSync(new URL("../dashboard/command.js", import.meta.url), "utf8");
const live = readFileSync(new URL("../dashboard/live-activity.js", import.meta.url), "utf8");
const sandbox: any = {};
vm.runInNewContext(live, sandbox);
vm.runInNewContext(src, sandbox);
const core = sandbox.ACPCommandCore;
const report = (agents: object, o: object = {}) => ({ status: "reported", readAt: iso(5_000), ttlMs: HEARTBEAT_TTL_MS, agents, ...o });

test("Team map: each of the five states gets its own avatar state and words", () => {
  const v = (a: object) => core.liveView(report({ claude: a }), "claude", NOW);
  const w = v({ state: "working", issue: "ARN-12", step: 3, at: iso(40_000) });
  assert.equal(w.state, "working");
  assert.equal(w.label, "Working");
  assert.match(w.detail, /^ARN-12 · step 3 · last heartbeat 40s ago$/);
  assert.equal(v({ state: "idle" }).label, "Idle");
  assert.equal(v({ state: "blocked", issue: "ARN-12", at: iso(120_000) }).detail, "ARN-12 · 2 min ago");
  assert.equal(v({ state: "blocked", issue: "ARN-12", at: iso(120_000), stopped: true }).label, "Stopped");
  assert.equal(v({ state: "completed", issue: "ARN-12", at: iso(60_000) }).label, "Finished");
  const u = v({ state: "unknown", reason: "run went quiet without a result" });
  assert.equal(u.label, "Status unknown");
  assert.equal(u.detail, "run went quiet without a result");
});

test("Team map fails closed: no report, failed read, stale check, aged heartbeat, odd shapes", () => {
  const unk = (activity: any, key = "claude") => core.liveView(activity, key, NOW).state;
  assert.equal(unk(undefined), "unknown");
  assert.equal(unk({ status: "unavailable" }), "unknown");
  assert.equal(unk({ status: "unconfigured" }), "unknown");
  assert.equal(unk({ status: "incomplete", readAt: iso(1_000), ttlMs: HEARTBEAT_TTL_MS, agents: { claude: { state: "working", issue: "ARN-1", at: iso(1_000) } } }), "unknown");
  assert.equal(unk(report({ claude: { state: "working", issue: "ARN-1", at: iso(1_000) } }, { readAt: iso(HEARTBEAT_TTL_MS + 1_000) })), "unknown", "page stopped refreshing");
  assert.equal(unk(report({ claude: { state: "working", issue: "ARN-1", at: iso(HEARTBEAT_TTL_MS + 1_000) } })), "unknown");
  assert.equal(unk(report({ claude: { state: "working", issue: "<img>", at: iso(1_000) } })), "unknown");
  assert.equal(unk(report({ claude: { state: "busy" } })), "unknown");
  assert.equal(unk(report({})), "unknown");
  assert.equal(unk(report({}, { ttlMs: "x" })), "unknown");
  assert.equal(unk(report({}), "codex"), "unknown", "Codex isn't run by the engine: its live work can't be seen");
  assert.equal(core.liveView(report({}), "gemini", NOW), null, "suspended AI keeps its Suspended card, no live line");
  assert.equal(core.liveView(report({}), "shared", NOW), null);
  assert.equal(core.liveView(report({}), "none", NOW), null);
});

test("Team map: only working animates, motion respects reduced motion and hidden tabs, mobile keeps the card grid", () => {
  const css = readFileSync(new URL("../dashboard/worker-activity.css", import.meta.url), "utf8");
  const html = readFileSync(new URL("../dashboard/command.html", import.meta.url), "utf8");
  const animated = [...css.matchAll(/([^{}]+)\{[^}]*animation:live-/g)].map(m => m[1]!.trim());
  assert.ok(animated.length > 0);
  assert.ok(animated.every(sel => sel.includes("live-working")), "only the working state moves: " + animated.join(" | "));
  assert.match(css, /prefers-reduced-motion:reduce\)\{[^}]*animation:none!important/);
  assert.match(css, /html\[data-hidden\][^{]*\{animation-play-state:paused\}/);
  assert.doesNotMatch(css, /grid-template-columns|position:fixed|width:\s*\d{3,}px/, "no layout change that could break the phone layout");
  assert.match(css, /\.live-line\{[^}]*flex-wrap:wrap[^}]*overflow-wrap:anywhere/);
  assert.match(html, /<link rel="stylesheet" href="nexia.css">\n<link rel="stylesheet" href="worker-activity.css">/);
  assert.match(src, /visibilitychange/);
  assert.match(src, /badge\.classList\.add\("live", "live-" \+ live\.state\)/);
});

// ---------- review corrections (ChatGPT, PR #146) ----------

test("bounded reads: a claim that changes between the two claim reads is unknown, not working", async () => {
  const rows = [row("started", 40_000), row("step", 10_000)];
  let n = 0;
  const f = (async (url: any) => {
    const u = String(url);
    if (u.includes("/acp_activity")) return Response.json(rows);
    n++;
    // The second claims read sees another run take the task over while the rows were being read.
    return Response.json([n === 1 ? claim("iss-1", "acp:claude", "run-a") : claim("iss-1", "acp:claude", "run-b", 1_000)]);
  }) as typeof fetch;
  const r = await readActivity(DB, f, NOW);
  assert.equal(r.status, "reported");
  assert.equal(r.agents.claude.state, "unknown");
  assert.match(r.agents.claude.reason, /changed while it was read/);
});

test("bounded reads: a full page of rows or claims is incomplete, never trimmed into a state", async () => {
  const many = Array.from({ length: ROW_LIMIT }, (_, i) => row("step", 10_000, { seq: i + 2 }));
  for (const [rows, claims] of [[many, [claim("iss-1", "acp:claude", "run-a")]], [[row("step", 10_000)], Array.from({ length: CLAIM_LIMIT }, (_, i) => claim("iss-" + i, "acp:claude", "run-" + i))]] as const) {
    const r = await readActivity(DB, fakeDb(rows as any[], claims as any[]).f, NOW);
    assert.equal(r.status, "incomplete");
    assert.deepEqual(Object.values(r.agents).map((a: any) => a.state), ["unknown", "unknown", "unknown", "unknown"]);
  }
});

test("empty telemetry with a live claim is unknown; an old finished claim with no rows is idle", () => {
  assert.equal(project([], [claim("iss-1", "acp:perplexity", "run-a", 30_000)]).perplexity.state, "unknown");
  assert.equal(project([], [claim("iss-1", "acp:perplexity", "run-a", LEASE_MS + 30_000)]).perplexity.state, "idle");
});

test("claim times are validated: a future or unreadable claim time fences nothing and reads unknown", () => {
  const rows = [row("started", 40_000), row("step", 10_000)];
  for (const bad of [{ ...claim("iss-1", "acp:claude", "run-a"), claimed_at: iso(-10 * 60_000) }, { ...claim("iss-1", "acp:claude", "run-a"), claimed_at: "yesterday" }]) {
    const p = projectActivity({ ok: true, rows, claims: [bad], nowMs: NOW });
    assert.equal(p.agents.claude.state, "unknown");
    assert.match(p.agents.claude.reason, /claim time is invalid/);
    assert.equal(p.dropped, 2);
  }
});

test("admission: a run that only started (no model call admitted yet) is unknown, not working", () => {
  const a = project([row("started", 5_000)], [claim("iss-1", "acp:claude", "run-a", 6_000)]);
  assert.equal(a.claude.state, "unknown");
  assert.match(a.claude.reason, /no model call admitted/);
});

test("Linear cross-check: a fresh heartbeat on a task Linear shows as done or back in Todo is unknown", () => {
  const rows = [row("started", 40_000), row("step", 10_000)], claims = [claim("iss-1", "acp:claude", "run-a")];
  for (const state of ["completed", "canceled", "unstarted"]) {
    const p = projectActivity({ ok: true, rows, claims, linear: new Map([["ARN-12", state]]), nowMs: NOW });
    assert.equal(p.agents.claude.state, "unknown", state);
    assert.match(p.agents.claude.reason, /no longer shows it in progress/);
  }
  assert.equal(projectActivity({ ok: true, rows, claims, linear: new Map([["ARN-12", "started"]]), nowMs: NOW }).agents.claude.state, "working");
});

test("console overview: the board's own Linear states cross-check a working report", async () => {
  const env = { ACP_SITE_PASSWORD: "pw", LINEAR_API_KEY: "lin", ...DB };
  const req = { method: "POST", headers: { "x-acp-password": "pw" }, body: { action: "overview" } };
  const node = { id: "iss-1", identifier: "ARN-12", title: "[Claude] x", url: "https://linear.app/a/issue/ARN-12", priority: 0, updatedAt: iso(1), completedAt: iso(1),
    team: { id: "faa75915-076f-479a-a3fb-92af2369e6c3" }, project: { id: "e8cf8cda-3347-4310-aea5-e6b7c7b95b4f" }, parent: null, state: { name: "Done", type: "completed" }, labels: { nodes: [] }, assignee: null };
  const db = fakeDb([row("started", 40_000), row("step", 10_000)], [claim("iss-1", "acp:claude", "run-a")]);
  const f = (async (url: any, init: any) => {
    if (String(url).includes("supabase")) return db.f(url, init);
    const q = JSON.parse(init.body).query as string;
    if (q.includes("ConsoleEngineStatus")) return Response.json({ data: { project: { documents: { nodes: [], pageInfo: { hasNextPage: false } } } } });
    if (q.includes("ConsoleResults")) return Response.json({ data: { issues: { nodes: [] } } });
    return Response.json({ data: { issues: { nodes: [node], pageInfo: { hasNextPage: false } } } });
  }) as typeof fetch;
  const r: any = await handle(req, env, f, () => new Date(NOW));
  assert.equal(r.status, 200);
  assert.equal(r.body.activity.agents.claude.state, "unknown");
});

test("engine admission: a model call refused before it goes out writes no heartbeat", async () => {
  // Stop everything is open when the run starts and closed at the first model call's own check.
  const store = new Store(); store.add({ title: "[ChatGPT] check docs" });
  const activity = memoryActivity("run-b");
  let checks = 0;
  const chatgpt: ModelClient = { async chat() { throw new Error("must not be called"); } };
  await tick(deps(store, { chatgpt }, { activity, halt: async () => (++checks <= 1 ? null : STOPPED) }));
  assert.equal(kinds(activity), "started,stopped");
});

test("sink: a terminal row is retried once; a heartbeat is not", async () => {
  const calls: string[] = [];
  let fail = true;
  const f = (async (_u: any, init: any) => { calls.push(JSON.parse(init.body).kind); if (fail) { fail = false; return new Response("{}", { status: 503 }); } return new Response(null, { status: 201 }); }) as typeof fetch;
  const sink = supabaseActivity("https://x.supabase.co", "k", "run", f, () => NOW);
  await sink.record({ id: "i1", identifier: "ARN-1" }, "acp:claude", "done");
  assert.deepEqual(calls, ["done", "done"]);
  fail = true; calls.length = 0;
  await sink.record({ id: "i1", identifier: "ARN-1" }, "acp:claude", "step", 1);
  assert.deepEqual(calls, ["step"]);
});

test("task rows: taskWorking is true only for a fresh working report naming that task", () => {
  const L = sandbox.ACPLive;
  const rep = report({ claude: { state: "working", issue: "ARN-12", at: iso(20_000), issues: ["ARN-12"] } });
  assert.equal(L.taskWorking(rep, "ARN-12", NOW), true);
  assert.equal(L.taskWorking(rep, "ARN-13", NOW), false);
  assert.equal(L.taskWorking({ ...rep, status: "unavailable" }, "ARN-12", NOW), false);
  assert.equal(L.taskWorking(rep, "ARN-12", NOW + HEARTBEAT_TTL_MS), false, "the report ages out");
  assert.equal(L.taskWorking(report({ claude: { state: "completed", issue: "ARN-12", at: iso(20_000) } }), "ARN-12", NOW), false);
});
