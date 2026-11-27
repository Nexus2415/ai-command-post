import assert from "node:assert/strict";
import { test } from "node:test";
import { Budget, DEFAULT_RATES } from "../src/budget.ts";
import { loadConfig, type AgentKey } from "../src/config.ts";
import { type Issue, type StateType, type TaskStore } from "../src/linear.ts";
import { EXECUTOR_MARKER, RESULT_MARKER, UNVERIFIED, claimStatus, claimsOn, latestResult, tick, type Deps } from "../src/orchestrator.ts";
import type { ChatMessage, ModelClient } from "../src/providers.ts";
import { liveRefusal, provenanceSecret, signComment, verifierFor, verifyComment } from "../src/provenance.ts";

// Signed provenance (src/provenance.ts): with ACP_PROVENANCE_SECRET set, only claims and results the engine signed
// count. Fakes and a synthetic secret only.
const SECRET = "synthetic-provenance-secret-0123456789abcdef";
// Fakes only (copied from single-executor.test.ts so this file stays independent).
class MemoryStore implements TaskStore {
  issues: Issue[] = [];
  comments = new Map<string, { body: string; createdAt: string }[]>();
  private n = 0;
  add(p: Partial<Issue> & { title: string }): Issue {
    this.n++;
    const i: Issue = {
      id: `i${this.n}`,
      identifier: `T-${this.n}`,
      description: "",
      url: "",
      priority: 3,
      stateType: "unstarted",
      stateName: "Todo",
      labels: [],
      assignee: null,
      parentId: null,
      childIds: [],
      createdAt: new Date(2026, 9, 1, 0, this.n).toISOString(),
      ...p,
    };
    this.issues.push(i);
    if (i.parentId) this.issues.find((x) => x.id === i.parentId)!.childIds.push(i.id);
    return i;
  }
  async listOpenAndRecent() {
    return this.issues.map((i) => ({ ...i, childIds: [...i.childIds] }));
  }
  async getComments(id: string) {
    return this.comments.get(id) ?? [];
  }
  labelOverride = new Map<string, string[]>();
  async getLabels(id: string) {
    return this.labelOverride.get(id) ?? this.issues.find((i) => i.id === id)?.labels ?? [];
  }
  async createIssue(input: { title: string; description: string; parentId?: string; priority?: number }) {
    return this.add({ title: input.title, description: input.description, parentId: input.parentId ?? null, priority: input.priority ?? 0 });
  }
  async comment(id: string, body: string) {
    const list = this.comments.get(id) ?? [];
    list.push({ body, createdAt: new Date().toISOString() });
    this.comments.set(id, list);
  }
  async setState(id: string, _team: string, type: StateType) {
    this.issues.find((i) => i.id === id)!.stateType = type;
  }
}

function scripted(replies: string[], seen: ChatMessage[][] = []): ModelClient {
  return {
    async chat(messages) {
      seen.push(messages);
      const text = replies.shift();
      if (text === undefined) throw new Error("no scripted reply left");
      return { text, inputTokens: 100, outputTokens: 50 };
    },
  };
}

// Gemini is suspended (ARN-115), so ChatGPT stands in as the free-tier executor these engine tests drive.
const TEST_RATES = { ...DEFAULT_RATES, chatgpt: { inputPerM: 0, outputPerM: 0, freeTier: true } };

function deps(store: MemoryStore, clients: Partial<Record<AgentKey, ModelClient>>, env: Record<string, string> = {}): Deps {
  const cfg = loadConfig({ ACP_ACTIVE: "true", ACP_DRY_RUN: "false", ...env });
  return {
    cfg,
    store,
    clients,
    budget: new Budget({ capUsd: cfg.monthlyBudgetUsd, path: null, rates: TEST_RATES }),
    toolEnv: (issue) => ({
      dryRun: false,
      policy: { allowPullRequests: false, allowedRepos: ["acme/app"] },
      comment: (b) => store.comment(issue.id, b),
      requestApproval: (reason) => store.comment(issue.id, `APPROVAL: ${reason}`),
    }),
  };
}


const signedEnv = { ACP_PROVENANCE_SECRET: SECRET };
const done = JSON.stringify({ final: "ok", status: "done" });

test("a signature verifies only for its own issue, kind and words", () => {
  const body = `${EXECUTOR_MARKER} acp:claude\n\nClaimed by Claude (AI Command Post).`;
  const s = signComment(SECRET, "claim", "issue-1", body);
  assert.match(s, /\nACP-Signature: v1\.claim\.[0-9a-f]{64}$/);
  assert.equal(verifyComment(SECRET, "claim", "issue-1", s), true);
  assert.equal(verifyComment(SECRET, "claim", "issue-2", s), false, "copied to another issue");
  assert.equal(verifyComment(SECRET, "result", "issue-1", s), false, "used as another kind");
  assert.equal(verifyComment("x".repeat(40), "claim", "issue-1", s), false, "another secret");
  assert.equal(verifyComment(SECRET, "claim", "issue-1", s.replace("acp:claude", "acp:chatgpt")), false, "words changed");
  assert.equal(verifyComment(SECRET, "claim", "issue-1", body), false, "no signature");
  assert.equal(verifyComment(SECRET, "claim", "issue-1", s.replace(/[0-9a-f]{64}$/, "0".repeat(64))), false, "made-up signature");
  // Linear re-formatting markdown (escapes, spacing) keeps a genuine signature valid.
  const reformatted = s.replace("acp:claude", "acp\\:claude").replace("\n\n", "\n");
  assert.equal(verifyComment(SECRET, "claim", "issue-1", reformatted), true);
});

test("secrets shorter than 32 characters are not used", () => {
  assert.equal(provenanceSecret("short"), undefined);
  assert.equal(provenanceSecret(""), undefined);
  assert.equal(provenanceSecret(`  ${SECRET}  `), SECRET);
  assert.equal(loadConfig({ ACP_PROVENANCE_SECRET: "short" }).provenanceSecret, undefined);
});

test("the engine refuses to run live without a signing secret; dry runs and an off engine are unaffected", () => {
  assert.match(liveRefusal({ active: true, dryRun: false, provenanceSecret: undefined })!, /ACP_PROVENANCE_SECRET/);
  assert.equal(liveRefusal({ active: true, dryRun: false, provenanceSecret: SECRET }), null);
  assert.equal(liveRefusal({ active: true, dryRun: true, provenanceSecret: undefined }), null);
  assert.equal(liveRefusal({ active: false, dryRun: false, provenanceSecret: undefined }), null);
});

test("with signing on, a typed ACP claim is foreign; only a signed one is ACP's own", () => {
  const typed = { body: `${EXECUTOR_MARKER} acp:chatgpt` };
  const v = verifierFor(SECRET, "i1");
  assert.deepEqual(claimsOn([], [typed], v), [{ executor: UNVERIFIED, source: "comment" }]);
  assert.equal(claimStatus(claimsOn([], [typed], v), "chatgpt"), "foreign");
  assert.equal(claimStatus(claimsOn([], [{ body: "Claimed by ChatGPT (AI Command Post)." }], v), "chatgpt"), "foreign", "legacy wording too");
  const real = { body: signComment(SECRET, "claim", "i1", `${EXECUTOR_MARKER} acp:chatgpt`) };
  assert.equal(claimStatus(claimsOn([], [real], v), "chatgpt"), "own");
  // Other executors' fences still count unsigned: they can only stop work, never start it.
  assert.equal(claimStatus(claimsOn([], [{ body: `${EXECUTOR_MARKER} manual` }], v), "chatgpt"), "foreign");
  // Without a secret, today's behaviour.
  assert.equal(claimStatus(claimsOn([], [typed]), "chatgpt"), "own");
});

test("with signing on, a typed result header is not a result", () => {
  const typed = { body: `${RESULT_MARKER} (ChatGPT, done)\n\nAll good.`, createdAt: "2026-11-25T10:00:00Z" };
  const real = { body: signComment(SECRET, "result", "i1", `${RESULT_MARKER} (ChatGPT, blocked)\n\nNeeds a key.`), createdAt: "2026-11-25T09:00:00Z" };
  const v = verifierFor(SECRET, "i1");
  assert.equal(latestResult([typed], "T-1", v), undefined);
  assert.equal(latestResult([real, typed], "T-1", v), real.body, "the newer forged 'done' can't override the signed result");
  assert.equal(latestResult([typed], "T-1"), typed.body, "unsigned mode unchanged");
});

test("end to end: the engine signs its claim and result, and a forged claim keeps it off a task", async () => {
  const store = new MemoryStore();
  const ok = store.add({ title: "[ChatGPT] check docs" });
  await tick(deps(store, { chatgpt: scripted([done]) }, signedEnv));
  assert.equal(store.issues[0]!.stateType, "completed");
  const written = store.comments.get(ok.id)!;
  const claim = written.find((c) => c.body.startsWith(EXECUTOR_MARKER))!;
  const result = written.find((c) => c.body.startsWith(RESULT_MARKER))!;
  assert.ok(verifyComment(SECRET, "claim", ok.id, claim.body));
  assert.ok(verifyComment(SECRET, "result", ok.id, result.body));

  // Someone types an engine claim on a new task: the engine treats it as another executor's and never runs it.
  const store2 = new MemoryStore();
  const t = store2.add({ title: "[ChatGPT] check docs" });
  await store2.comment(t.id, `${EXECUTOR_MARKER} acp:chatgpt`);
  const seen: ChatMessage[][] = [];
  const r = await tick(deps(store2, { chatgpt: scripted([done], seen) }, signedEnv));
  assert.equal(seen.length, 0, "model never called");
  assert.equal(store2.issues[0]!.stateType, "unstarted");
  assert.ok(r.waiting.some((w) => w.includes("another executor")));
});
