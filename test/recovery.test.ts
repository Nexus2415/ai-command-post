// Crash recovery (src/recovery.ts): a task whose engine run died is resumed, never stranded, never double-run.
// Synthetic only: an in-memory Linear, an in-memory claim store, scripted models and a fake GitHub.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Budget, DEFAULT_RATES } from "../src/budget.ts";
import { LEASE_MS, memoryClaims } from "../src/claims.ts";
import { loadConfig, type AgentKey } from "../src/config.ts";
import type { Issue, StateType, TaskStore } from "../src/linear.ts";
import { RESULT_MARKER, tick, type Deps } from "../src/orchestrator.ts";
import { signComment } from "../src/provenance.ts";
import type { ChatMessage, ModelClient } from "../src/providers.ts";
import { MAX_RECOVERIES, PR_RECORD_MARKER, RECOVERY_MARKER, strandedRun } from "../src/recovery.ts";
import { STOPPED } from "../src/stop-switch.ts";
import * as wa from "../api/_lib/worker-activity.js";

const SECRET = "s".repeat(40);
const T0 = Date.parse("2026-11-28T10:00:00Z");
const REPO = "acme/app";
let clock = T0;
const now = () => clock;

class MemoryStore implements TaskStore {
  issues: Issue[] = [];
  comments = new Map<string, { body: string; createdAt: string }[]>();
  private n = 0;
  add(p: Partial<Issue> & { title: string }): Issue {
    this.n++;
    const i: Issue = {
      id: `i${this.n}`, identifier: `T-${this.n}`, description: "", url: "", priority: 3, stateType: "unstarted", stateName: "Todo",
      labels: [], assignee: null, parentId: null, childIds: [], createdAt: new Date(T0 - 86_400_000 + this.n).toISOString(), ...p,
    };
    this.issues.push(i);
    return i;
  }
  async listOpenAndRecent() {
    return this.issues.map((i) => ({ ...i, childIds: [...i.childIds] }));
  }
  async getComments(id: string) {
    return [...(this.comments.get(id) ?? [])];
  }
  async getLabels(id: string) {
    return this.issues.find((i) => i.id === id)?.labels ?? [];
  }
  async createIssue(input: { title: string; description: string }) {
    return this.add({ title: input.title, description: input.description });
  }
  async comment(id: string, body: string, at = clock) {
    const list = this.comments.get(id) ?? [];
    list.push({ body, createdAt: new Date(at).toISOString() });
    this.comments.set(id, list);
  }
  async setState(id: string, _team: string, type: StateType) {
    const i = this.issues.find((x) => x.id === id)!;
    if (type === "started" && i.stateType !== "started") i.startedAt = new Date(clock).toISOString();
    i.stateType = type;
  }
  texts(id: string) {
    return (this.comments.get(id) ?? []).map((c) => c.body);
  }
}

function scripted(replies: string[], seen: ChatMessage[][] = []): ModelClient {
  return {
    async chat(messages) {
      seen.push(messages.map((m) => ({ ...m })));
      const text = replies.shift();
      if (text === undefined) throw new Error("no scripted reply left");
      if (text === "HANG") return new Promise(() => {}); // the runner dies here: nothing after this ever happens
      return { text, inputTokens: 100, outputTokens: 50 };
    },
  };
}

/** A fake GitHub: counts pull requests opened and pushes made. */
function github() {
  const calls: { method: string; path: string }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const u = new URL(url);
    calls.push({ method, path: u.pathname });
    let json: unknown = {};
    if (u.pathname === `/repos/${REPO}`) json = { default_branch: "main" };
    else if (u.pathname.includes("/git/ref/heads/")) json = { object: { sha: "base-sha" } };
    else if (u.pathname.endsWith("/pulls")) json = { number: 7, html_url: "https://github.com/acme/app/pull/7" };
    else if (method === "GET" && u.pathname.includes("/contents/")) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(json), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, f, opened: () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/pulls")).length };
}

const RATES = { ...DEFAULT_RATES, claude: { inputPerM: 0, outputPerM: 0, freeTier: true } };
function deps(store: MemoryStore, clients: Partial<Record<AgentKey, ModelClient>>, o: { claims?: Deps["claims"] | null; halt?: Deps["halt"]; f?: typeof fetch } = {}): Deps {
  const cfg = loadConfig({ ACP_ACTIVE: "true", ACP_DRY_RUN: "false", ACP_PROVENANCE_SECRET: SECRET, ACP_MAX_STEPS: "6" });
  return {
    cfg, store, clients, now,
    budget: new Budget({ capUsd: cfg.monthlyBudgetUsd, path: null, rates: RATES }),
    ...(o.claims === null ? {} : { claims: o.claims ?? memoryClaims(new Map(), now) }),
    ...(o.halt ? { halt: o.halt } : {}),
    toolEnv: (issue) => ({
      dryRun: false, githubToken: "t", ...(o.f ? { f: o.f } : {}),
      policy: { allowPullRequests: true, allowedRepos: [REPO] },
      comment: (b) => store.comment(issue.id, `TOOL: ${b}`),
      requestApproval: (reason) => store.comment(issue.id, `APPROVAL: ${reason}`),
    }),
  };
}

const claimBody = "ACP executor: acp:claude\n\nClaimed by Claude (AI Command Post).";
/** A task an earlier Claude run claimed and moved to In Progress `ago` ms before now, then died on. */
function strandedTask(store: MemoryStore, ago = LEASE_MS + 60_000, title = "[Claude] fix the footer"): Issue {
  const t = store.add({ title, stateType: "started", stateName: "In Progress", startedAt: new Date(clock - ago).toISOString() });
  store.comment(t.id, signComment(SECRET, "claim", t.id, claimBody), clock - ago - 1_000);
  return t;
}
/** The dead run's row in the claim store, taken `ago` ms before now. */
const deadRow = (t: Issue, ago = LEASE_MS + 60_000) => new Map([[t.id, { executor: "acp:claude", run: "dead-run", at: clock - ago }]]);

const done = JSON.stringify({ final: "Fixed. PR https://github.com/acme/app/pull/7, checks ALL PASSED", status: "done" });

test("guard: the claim lease outlives the longest engine run, and the Team map uses the same lease", () => {
  const yml = readFileSync(new URL("../.github/workflows/engine.yml", import.meta.url), "utf8");
  const minutes = Number(/timeout-minutes:\s*(\d+)/.exec(yml)?.[1]);
  assert.ok(minutes > 0);
  assert.ok(LEASE_MS > minutes * 60_000, `LEASE_MS ${LEASE_MS} must exceed the ${minutes}-minute job limit`);
  assert.equal(wa.LEASE_MS, LEASE_MS);
});

test("killed run: its In Progress task is resumed, finished and marked Done", async () => {
  clock = T0;
  const store = new MemoryStore();
  const t = strandedTask(store);
  const seen: ChatMessage[][] = [];
  const r = await tick(deps(store, { claude: scripted([done], seen) }, { claims: memoryClaims(deadRow(t), now) }));
  assert.equal(seen.length, 1, "one model call: the task was resumed");
  assert.match(String(seen[0]![1]!.content), /Recovery 1 of 2: an earlier engine run on this task was interrupted/);
  assert.equal(store.issues[0]!.stateType, "completed");
  assert.ok(store.texts(t.id).some((b) => b.startsWith(`${RECOVERY_MARKER} 1/${MAX_RECOVERIES}`)));
  assert.ok(r.worked.some((w) => w.includes("done")));
});

test("live run: a task inside the lease is never touched, by its In Progress time or by the claim row", async () => {
  clock = T0;
  // Recently started: the run that moved it may still be working.
  const store = new MemoryStore();
  const fresh = strandedTask(store, 10 * 60_000);
  const seen: ChatMessage[][] = [];
  await tick(deps(store, { claude: scripted([done], seen) }, { claims: memoryClaims(deadRow(fresh, 10 * 60_000), now) }));
  assert.equal(seen.length, 0);
  assert.equal(store.issues[0]!.stateType, "started");
  assert.equal(store.texts(fresh.id).length, 1, "nothing written");

  // Old In Progress time, but another Claude run holds the claim row inside its lease: back off, write nothing.
  const store2 = new MemoryStore();
  const t2 = strandedTask(store2);
  const live = new Map([[t2.id, { executor: "acp:claude", run: "live-run", at: clock - 60_000 }]]);
  const r2 = await tick(deps(store2, { claude: scripted([done], seen) }, { claims: memoryClaims(live, now) }));
  assert.equal(seen.length, 0, "no model call while a live run holds it");
  assert.equal(store2.issues[0]!.stateType, "started");
  assert.equal(store2.texts(t2.id).length, 1, "no recovery comment");
  assert.ok(r2.waiting.some((w) => w.includes("holds it in the claim store")));
  assert.equal(live.get(t2.id)!.run, "live-run", "the live run keeps its row");
});

test("not stranded: a task with a result since it started, a person's In Progress task, a fenced or forged claim, no start time", async () => {
  clock = T0;
  const store = new MemoryStore();
  // Left In Progress on purpose: its result says the PR waits for the owner's merge.
  const waiting = strandedTask(store);
  store.comment(waiting.id, signComment(SECRET, "result", waiting.id, `${RESULT_MARKER} (Claude, done)\n\nPR waits for merge.`), clock - LEASE_MS);
  // A person moved it to In Progress; the engine never claimed it.
  store.add({ title: "[Claude] my own work", stateType: "started", startedAt: new Date(clock - 2 * LEASE_MS).toISOString() });
  // Fenced by a person.
  const fenced = store.add({ title: "[Claude] fenced", stateType: "started", startedAt: new Date(clock - 2 * LEASE_MS).toISOString() });
  store.comment(fenced.id, "ACP executor: manual", clock - 3 * LEASE_MS);
  // An unsigned (typed) claim is a foreign claim.
  const forged = store.add({ title: "[Claude] forged", stateType: "started", startedAt: new Date(clock - 2 * LEASE_MS).toISOString() });
  store.comment(forged.id, claimBody, clock - 3 * LEASE_MS);
  // No startedAt: can't tell when it started, so it is left alone.
  const unknown = store.add({ title: "[Claude] no time", stateType: "started" });
  store.comment(unknown.id, signComment(SECRET, "claim", unknown.id, claimBody), clock - 3 * LEASE_MS);
  const seen: ChatMessage[][] = [];
  await tick(deps(store, { claude: scripted([done, done, done, done, done], seen) }));
  assert.equal(seen.length, 0);
  assert.ok(store.issues.every((i) => i.stateType === "started"));
});

test("a result whose time can't be read counts as newer, so the task is left alone", () => {
  const t = { stateType: "started", startedAt: new Date(T0 - 2 * LEASE_MS).toISOString(), id: "x" } as Issue;
  assert.equal(strandedRun(t, [{ body: `${RESULT_MARKER} (Claude, blocked)\n\nx`, createdAt: "not a time" }], T0, SECRET), null);
  assert.ok(strandedRun(t, [{ body: `${RESULT_MARKER} (Claude, done)\n\nold`, createdAt: new Date(T0 - 3 * LEASE_MS).toISOString() }], T0, SECRET));
});

test("without the claim store nothing is resumed: it can't be proved that no run still holds the task", async () => {
  clock = T0;
  const store = new MemoryStore();
  const t = strandedTask(store);
  const seen: ChatMessage[][] = [];
  const r = await tick(deps(store, { claude: scripted([done], seen) }, { claims: null }));
  assert.equal(seen.length, 0);
  assert.equal(store.texts(t.id).length, 1);
  assert.ok(r.waiting.some((w) => w.includes("without the claim store")));
});

test("two runs racing one stranded task: exactly one resumes it", async () => {
  clock = T0;
  const store = new MemoryStore();
  const t = strandedTask(store);
  const rows = deadRow(t);
  const seenA: ChatMessage[][] = [], seenB: ChatMessage[][] = [];
  const [a, b] = await Promise.all([
    tick(deps(store, { claude: scripted([done], seenA) }, { claims: memoryClaims(rows, now) })),
    tick(deps(store, { claude: scripted([done], seenB) }, { claims: memoryClaims(rows, now) })),
  ]);
  assert.equal(seenA.length + seenB.length, 1, "one model call in total");
  assert.equal(store.texts(t.id).filter((x) => x.startsWith(RECOVERY_MARKER)).length, 1, "one recovery comment");
  assert.ok([...a.waiting, ...b.waiting].some((w) => w.includes("holds it in the claim store")));
  assert.equal(store.issues[0]!.stateType, "completed");
});

test("stop switch: stopped before the run writes nothing; stopped mid-recovery sends the task to Todo with no model call", async () => {
  clock = T0;
  const store = new MemoryStore();
  const t = strandedTask(store);
  const seen: ChatMessage[][] = [];
  await tick(deps(store, { claude: scripted([done], seen) }, { claims: memoryClaims(deadRow(t), now), halt: async () => STOPPED }));
  assert.equal(seen.length, 0);
  assert.equal(store.texts(t.id).length, 1, "no recovery comment");
  assert.equal(store.issues[0]!.stateType, "started");

  // Open for the run start, stopped from the first model call on (pressed after recovery began).
  let checks = 0;
  const r = await tick(deps(store, { claude: scripted([done], seen) }, { claims: memoryClaims(deadRow(t), now), halt: async () => (++checks <= 1 ? null : STOPPED) }));
  assert.equal(seen.length, 0, "the model was never called");
  assert.equal(store.issues[0]!.stateType, "unstarted", "back to Todo: nothing ran, so a normal retry is safe");
  assert.ok(r.waiting.some((w) => w.includes(STOPPED)));
});

test("bounded: a task interrupted more than twice is closed as blocked with no model call", async () => {
  clock = T0;
  const store = new MemoryStore();
  const t = strandedTask(store, 3 * LEASE_MS);
  store.comment(t.id, `${RECOVERY_MARKER} 1/2: earlier`, clock - 2 * LEASE_MS);
  store.comment(t.id, `${RECOVERY_MARKER} 2/2: earlier`, clock - LEASE_MS - 30_000);
  const seen: ChatMessage[][] = [];
  const r = await tick(deps(store, { claude: scripted([done], seen) }, { claims: memoryClaims(deadRow(t), now) }));
  assert.equal(seen.length, 0);
  assert.equal(store.issues[0]!.stateType, "canceled");
  assert.ok(store.texts(t.id).some((b) => b.startsWith(`${RESULT_MARKER} (Claude, blocked)`) && b.includes("interrupted 3 times")));
  assert.ok(r.worked.some((w) => w.includes("interrupted 3 times")));
  // Recovery markers from before the task last entered In Progress don't count against a fresh retry.
  const again = strandedRun({ ...store.issues[0]!, stateType: "started", startedAt: new Date(clock).toISOString() }, await store.getComments(t.id), clock + LEASE_MS + 1, SECRET);
  assert.equal(again, null, "once it has a result, it is no longer stranded");
});

test("no duplicate PR: a run killed after opening its PR is resumed on that same PR", async () => {
  clock = T0;
  const store = new MemoryStore();
  const gh = github();
  const t = store.add({ title: "[Claude] fix the footer" });
  const rows = new Map<string, { executor: string; run: string; at: number }>();
  const open = JSON.stringify({ tool: "github.open_pull_request", input: { repo: REPO, branch: "acp/fix-footer", title: "Fix the footer", body: "x", files: [{ path: "src/a.ts", content: "a" }] } });
  // Run 1 opens the PR, then its runner dies while waiting on the next model reply. Never awaited.
  void tick(deps(store, { claude: scripted([open, "HANG"]) }, { claims: memoryClaims(rows, now), f: gh.f }));
  for (let i = 0; i < 50 && !store.texts(t.id).some((b) => b.startsWith(PR_RECORD_MARKER)); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(gh.opened(), 1);
  assert.ok(store.texts(t.id).some((b) => b.startsWith(`${PR_RECORD_MARKER} https://github.com/acme/app/pull/7 on ${REPO} from acp/fix-footer`)));
  assert.equal(store.issues[0]!.stateType, "started", "stranded In Progress");

  // 31 minutes later the next run resumes it and pushes its fix to the same branch.
  clock = T0 + LEASE_MS + 60_000;
  const push = JSON.stringify({ tool: "github.update_pull_request", input: { repo: REPO, branch: "acp/fix-footer", message: "Finish", files: [{ path: "src/a.ts", content: "b" }] } });
  const seen: ChatMessage[][] = [];
  await tick(deps(store, { claude: scripted([push, done], seen) }, { claims: memoryClaims(rows, now), f: gh.f }));
  assert.match(String(seen[0]![1]!.content), /Do NOT open another one[\s\S]*pull\/7 \(repo acme\/app, branch acp\/fix-footer\)/);
  assert.match(String(seen[1]!.at(-1)!.content), /returned[\s\S]*Pushed 1 file\(s\) to acp\/fix-footer/);
  assert.equal(gh.opened(), 1, "still one pull request");
  assert.equal(store.issues[0]!.stateType, "completed");
});

test("a typed (unsigned) pull request record grants nothing: the resumed run can't push to that branch", async () => {
  clock = T0;
  const store = new MemoryStore();
  const gh = github();
  const t = strandedTask(store);
  store.comment(t.id, `${PR_RECORD_MARKER} https://github.com/acme/app/pull/9 on ${REPO} from acp/someone-else`, clock - LEASE_MS);
  const push = JSON.stringify({ tool: "github.update_pull_request", input: { repo: REPO, branch: "acp/someone-else", message: "x", files: [{ path: "src/a.ts", content: "b" }] } });
  const seen: ChatMessage[][] = [];
  await tick(deps(store, { claude: scripted([push, done], seen) }, { claims: memoryClaims(deadRow(t), now), f: gh.f }));
  assert.match(String(seen[0]![1]!.content), /none is a verified engine record/);
  assert.match(String(seen[1]!.at(-1)!.content), /failed[\s\S]*only update a pull request this task opened/);
  assert.equal(gh.calls.filter((c) => c.method === "PUT").length, 0, "nothing pushed");
});
