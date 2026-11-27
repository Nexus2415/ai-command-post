import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { handle } from "../api/console.js";
import { TEAM_ID, PROJECT_ID, executorsOf, projectIssue, SHARED_OBJECTIVES } from "../api/_lib/console-state.js";

// ARN-145: ownership (who a task is assigned to) is separate from execution attribution (which AI posted a
// "## Result (<AI>, done)"). Synthetic fixtures only.
const env = { ACP_SITE_PASSWORD: "pw", LINEAR_API_KEY: "lin" };
const req = () => ({ method: "POST", headers: { "x-acp-password": "pw" }, body: { action: "overview" } });
const node = (identifier: string, title: string, type = "completed", extra = {}) => ({
  id: "u-" + identifier, identifier, title, url: "https://linear.app/arnexyia/issue/" + identifier,
  priority: 0, updatedAt: "2026-11-27T10:00:00Z", completedAt: null,
  state: { name: type === "completed" ? "Done" : "In Progress", type }, team: { id: TEAM_ID }, project: { id: PROJECT_ID },
  labels: { nodes: [] }, ...extra,
});
const c = (body: string) => ({ body });

test("only a '## Result (<AI>, done)' first line counts as execution evidence", () => {
  assert.deepEqual(executorsOf([
    c("## Result (Claude, done)\nDraft PR"), c("## Result (ChatGPT, in review) | x"), c("Signed — Perplexity"),
    c("Quoting: ## Result (Gemini, done)"), c("### Result (OpenAI Codex, done) — review"), c("## Result (Claude, done) again"),
    c("## Result (Someone Else, done)"),
  ]), ["claude", "codex"]);
  assert.deepEqual(executorsOf([]), [], "read, nothing posted");
  assert.equal(executorsOf(undefined), null, "not read is unknown, not empty");
});

test("named shared objectives are Shared Operations; unmatched tasks stay unassigned; AI prefixes still win", () => {
  assert.ok(SHARED_OBJECTIVES.includes("ARN-12") && SHARED_OBJECTIVES.includes("ARN-9"));
  assert.equal(projectIssue(node("ARN-12", "Deploy and activate the mesh", "started")).owner, "shared");
  assert.equal(projectIssue(node("ARN-43", "[Command Post] Unified console")).owner, "shared");
  assert.equal(projectIssue(node("ARN-128", "[Engineering] Refuse grant issuance")).owner, null);
  assert.equal(projectIssue(node("ARN-11", "Restore current main validation")).owner, null, "not guessed from the title");
  assert.equal(projectIssue(node("ARN-12", "[Claude] took it over")).owner, "claude");
  assert.equal(projectIssue(node("ARN-94", "[Codex] Verify")).owner, "codex");
  // Completion alone never credits anyone.
  assert.equal(projectIssue(node("ARN-11", "Restore current main validation")).executedBy, null);
});

test("overview reads result comments only for unowned and shared tasks, and fills executedBy", async () => {
  const calls: any[] = [];
  const nodes = [node("ARN-128", "[Engineering] Refuse grant"), node("ARN-12", "Mesh", "started"), node("ARN-62", "[Claude] Broker")];
  const f = (async (_url: any, init: any) => {
    const b = JSON.parse(init.body); calls.push(b);
    if (/ConsoleResults/.test(b.query)) {
      return Response.json({ data: { issues: { nodes: [
        { id: "u-ARN-128", comments: { nodes: [c("## Result (Claude, done)"), c("## Result (ChatGPT, owner decision ready)")] } },
        { id: "u-ARN-62", comments: { nodes: [c("## Result (Perplexity, done)")] } }, // not asked for: ignored
      ] } } });
    }
    if (/ConsoleEngineStatus/.test(b.query)) return Response.json({ data: { project: { documents: { nodes: [], pageInfo: { hasNextPage: false } } } } });
    return Response.json({ data: { issues: { nodes, pageInfo: { hasNextPage: false } } } });
  }) as typeof fetch;
  const r: any = await handle(req(), env, f);
  assert.equal(r.status, 200);
  const q = calls.find(x => /ConsoleResults/.test(x.query));
  assert.deepEqual(q.variables.ids.sort(), ["u-ARN-12", "u-ARN-128"], "owned [Claude] work is not re-read");
  assert.equal(q.variables.team, TEAM_ID);
  assert.equal(q.variables.project, PROJECT_ID);
  const by = Object.fromEntries(r.body.issues.map((i: any) => [i.id, i]));
  assert.deepEqual(by["ARN-128"].executedBy, ["claude"]);
  assert.equal(by["ARN-128"].owner, null, "a result never changes ownership");
  assert.equal(by["ARN-12"].owner, "shared");
  assert.equal(by["ARN-12"].executedBy, null, "no evidence returned stays unknown");
  assert.equal(by["ARN-62"].executedBy, null);
});

test("a failed result read never breaks the board", async () => {
  const f = (async (_url: any, init: any) => {
    const b = JSON.parse(init.body);
    if (/ConsoleResults/.test(b.query)) return new Response("{}", { status: 500 });
    if (/ConsoleEngineStatus/.test(b.query)) return Response.json({ data: { project: { documents: { nodes: [], pageInfo: { hasNextPage: false } } } } });
    return Response.json({ data: { issues: { nodes: [node("ARN-128", "[Engineering] x")], pageInfo: { hasNextPage: false } } } });
  }) as typeof fetch;
  const r: any = await handle(req(), env, f);
  assert.equal(r.status, 200);
  assert.equal(r.body.issues[0].executedBy, null);
});

const load = (file: string, key: string) => {
  const sandbox: any = {};
  vm.runInNewContext(readFileSync(new URL("../dashboard/" + file, import.meta.url), "utf8"), sandbox);
  return sandbox[key];
};

test("team map: Shared Operations and Unassigned are separate groups, with results credited apart from ownership", () => {
  const core = load("command.js", "ACPCommandCore");
  const t = (id: string, lane: string, owner: string | null, executedBy: any) => ({ id, lane, owner, executedBy, kind: "task", title: id });
  const o = { issues: [
    t("ARN-12", "active", "shared", ["chatgpt"]), t("ARN-9", "active", "shared", []), t("ARN-6", "done", "shared", ["chatgpt", "claude"]),
    t("ARN-128", "done", null, ["claude"]), t("ARN-126", "done", null, ["claude"]), t("ARN-11", "done", null, null),
    t("ARN-62", "done", "claude", ["perplexity"]),
  ] };
  assert.deepEqual([...core.AGENTS.map((a: any) => a.name).slice(-2)], ["Shared Operations", "Unassigned"]);
  assert.ok(!core.AGENTS.some((a: any) => a.name === "Unclaimed"));
  const shared = core.agentStats(o, "shared"), none = core.agentStats(o, "none");
  assert.deepEqual([shared.active, shared.done], [2, 1]);
  assert.deepEqual([none.active, none.done], [0, 3]);
  assert.equal(core.agentStats(o, "claude").done, 1, "results on other tasks never move them into Claude's count");
  assert.equal(core.aisWithOpenTasks(o), 0, "groups are not AIs");
  assert.deepEqual(JSON.parse(JSON.stringify(core.resultCredits(o, "none"))), { credits: [{ key: "claude", name: "Claude", count: 2 }], unknown: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(core.resultCredits(o, "shared"))).credits.map((x: any) => x.name), ["ChatGPT", "Claude"]);
  assert.equal(core.resultCredits(o, "shared").unknown, 1);
  assert.equal(core.agentName("whatever"), "Unassigned");
});

test("task rows name the owner and, separately, who posted the result", () => {
  const W = load("work.js", "ACPWork");
  assert.equal(W.ownerName("shared"), "Shared Operations");
  assert.equal(W.ownerName(null), "Unassigned");
  assert.equal(W.resultBy({ owner: null, executedBy: ["claude"] }), "Result by Claude");
  assert.equal(W.resultBy({ owner: "shared", executedBy: ["chatgpt", "claude"] }), "Result by ChatGPT, Claude");
  assert.equal(W.resultBy({ owner: "claude", executedBy: ["claude"] }), "", "nothing new to say");
  assert.equal(W.resultBy({ owner: null, executedBy: null }), "", "unknown stays unknown");
  assert.equal(W.resultBy({ owner: null, executedBy: ["<img>"] }), "", "only known AI names are shown");
});
