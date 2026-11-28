// ARN-149: the engine's coder checks its own PR and fixes it. github.pr_checks waits for checks (fake sleep here) and
// shows failing log lines; github.update_pull_request writes only to a branch this task opened in this run.
// Synthetic only: a fake fetch stands in for GitHub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "../src/policy.ts";
import { AGENTS } from "../src/agents.ts";
import { CHECK_WAIT_MS, failureExcerpt, runTool, type ToolEnv } from "../src/tools.ts";

const REPO = "acme/app";
const SHA = "a".repeat(40);
const TOOLS = ["github.open_pull_request", "github.update_pull_request", "github.pr_checks"];

function rig(opts: { dryRun?: boolean; checks?: any[][]; log?: string; logStatus?: number; allowPullRequests?: boolean } = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const branchFiles: Record<string, string> = { "src/a.ts": "const a = 1;\n" };
  let poll = 0;
  const sleeps: number[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname + u.search, body });
    if (u.pathname === `/repos/${REPO}`) return Response.json({ default_branch: "main" });
    if (u.pathname.includes("/git/ref/heads/")) return Response.json({ object: { sha: "base" } });
    if (u.pathname === `/repos/${REPO}/pulls` && method === "POST") return Response.json({ number: 7, html_url: "https://github.com/acme/app/pull/7" });
    if (u.pathname === `/repos/${REPO}/pulls/7`) return Response.json({ head: { sha: SHA } });
    if (u.pathname.endsWith("/check-runs")) {
      const list = opts.checks ?? [[]];
      return Response.json({ check_runs: list[Math.min(poll++, list.length - 1)] });
    }
    if (u.pathname.includes("/actions/jobs/")) return new Response(opts.log ?? "", { status: opts.logStatus ?? 200 });
    if (u.pathname.includes("/contents/")) {
      const p = decodeURIComponent(u.pathname.split("/contents/")[1] ?? "");
      if (method === "PUT") {
        branchFiles[p] = Buffer.from(body.content, "base64").toString();
        return Response.json({});
      }
      if (branchFiles[p] !== undefined) return Response.json({ sha: "s", content: Buffer.from(branchFiles[p]).toString("base64") });
      return new Response("{}", { status: 404 });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  const env: ToolEnv = {
    githubToken: "t", dryRun: opts.dryRun ?? false, f,
    policy: { allowPullRequests: opts.allowPullRequests ?? true, allowedRepos: [REPO] },
    comment: async () => {}, requestApproval: async () => {},
    openedBranches: new Set(), sleep: async (ms) => { sleeps.push(ms); },
  };
  const run = (tool: string, input: Record<string, unknown>) => runTool({ tool, input: { repo: REPO, ...input } }, TOOLS, env);
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { calls, run, writes, sleeps, branchFiles, env };
}

const run = (name: string, conclusion: string | null, extra: object = {}) =>
  ({ id: 99, name, status: conclusion ? "completed" : "in_progress", conclusion, app: { slug: "github-actions" }, ...extra });

test("a task can fix its own PR: open, then push edits on top of the branch", async () => {
  const r = rig();
  const opened = await r.run("github.open_pull_request", { title: "Change", branch: "acp/change", files: [{ path: "src/b.ts", content: "b" }] });
  assert.equal(opened.ok, true, opened.output);
  assert.match(opened.output, /github\.pr_checks/);
  r.branchFiles["src/a.ts"] = "const a = 2;\n"; // the branch as it stands now, not main
  const up = await r.run("github.update_pull_request", { branch: "acp/change", message: "Fix test", files: [{ path: "src/a.ts", edits: [{ find: "= 2", replace: "= 3" }] }] });
  assert.equal(up.ok, true, up.output);
  assert.equal(r.branchFiles["src/a.ts"], "const a = 3;\n");
  const put = r.writes().at(-1)!;
  assert.equal(put.body.branch, "acp/change");
  assert.match(put.body.message, /^Fix test\n\nUpdated by AI Command Post$/);
});

test("update refuses any branch this task did not open in this run, before any GitHub call", async () => {
  for (const branch of ["acp/someone-else", "main", "feature/x"]) {
    const r = rig();
    const res = await r.run("github.update_pull_request", { branch, message: "x", files: [{ path: "src/a.ts", content: "x" }] });
    assert.equal(res.ok, false, branch);
    assert.equal(r.calls.length, 0, branch);
  }
  // Same branch name in a different repo is a different branch.
  const r = rig();
  r.env.openedBranches!.add("other/repo#acp/change");
  assert.equal((await r.run("github.update_pull_request", { branch: "acp/change", message: "x", files: [{ path: "a.md", content: "x" }] })).ok, false);
});

test("update keeps every PR guard: protected paths, PR switch, red words, one-line message", async () => {
  const r = rig();
  r.env.openedBranches!.add(`${REPO}#acp/change`);
  const bad = [
    { message: "x", files: [{ path: ".github/workflows/x.yml", content: "x" }] },
    { message: "x", files: [{ path: "src/policy.ts", edits: [{ find: "a", replace: "b" }] }] },
    { message: "merge this into main", files: [{ path: "a.md", content: "x" }] },
    { message: "two\nlines", files: [{ path: "a.md", content: "x" }] },
  ];
  for (const b of bad) assert.equal((await r.run("github.update_pull_request", { branch: "acp/change", ...b })).ok, false, JSON.stringify(b));
  assert.equal(r.writes().length, 0);
  assert.equal(decide("github.update_pull_request", { repo: REPO, message: "x" }, { allowPullRequests: false, allowedRepos: [REPO] }).allow, false);
  assert.equal(decide("github.pr_checks", { repo: REPO, pr: 1 }, { allowPullRequests: false, allowedRepos: [REPO] }).allow, true);
});

test("dry run: open then update logs both and writes nothing", async () => {
  const r = rig({ dryRun: true });
  assert.equal((await r.run("github.open_pull_request", { title: "C", branch: "acp/c", files: [{ path: "a.md", content: "x" }] })).ok, true);
  const up = await r.run("github.update_pull_request", { branch: "acp/c", message: "Fix", files: [{ path: "a.md", content: "y" }] });
  assert.match(up.output, /DRY RUN/);
  assert.equal(r.writes().length, 0);
});

test("pr_checks waits for checks to finish, then reports ALL PASSED", async () => {
  const r = rig({ checks: [[run("validate", null)], [run("validate", null)], [run("validate", "success"), run("Vercel", "success", { app: { slug: "vercel" } })]] });
  const res = await r.run("github.pr_checks", { pr: 7 });
  assert.equal(res.ok, true);
  assert.match(res.output, /ALL PASSED/);
  // Two polls while running, then one more to confirm no late check turned up.
  assert.equal(r.sleeps.length, 3);
});

test("pr_checks shows the failing lines of a failed test job", async () => {
  const log = "2026-11-27T16:00:00.0000000Z ok 1 - fine\n2026-11-27T16:00:01.0000000Z not ok 2 - adds numbers\n  error: expected 3, got 4\n# fail 1";
  const r = rig({ checks: [[run("validate", "failure", { output: { title: "Process completed with exit code 1", summary: "" } })]], log });
  const res = await r.run("github.pr_checks", { pr: 7 });
  assert.match(res.output, /FAILED/);
  assert.match(res.output, /not ok 2 - adds numbers/);
  assert.match(res.output, /expected 3, got 4/);
  assert.doesNotMatch(res.output, /2026-11-27T/);
});

test("pr_checks stops waiting at the limit and never says passed while checks run", async () => {
  const r = rig({ checks: [[run("validate", null)]] });
  const res = await r.run("github.pr_checks", { pr: 7 });
  assert.match(res.output, /STILL RUNNING/);
  assert.equal(r.sleeps.reduce((a, b) => a + b, 0), CHECK_WAIT_MS);
  const none = rig({ checks: [[]] });
  assert.match((await none.run("github.pr_checks", { pr: 7 })).output, /no checks have started/);
  assert.equal((await none.run("github.pr_checks", { pr: "7; rm" })).ok, false);
});

test("a missing log is reported, not hidden", async () => {
  const r = rig({ checks: [[run("validate", "failure")]], logStatus: 403 });
  assert.match((await r.run("github.pr_checks", { pr: 7 })).output, /log unavailable \(403\)/);
});

test("failure excerpt is bounded", () => {
  assert.ok(failureExcerpt("not ok\n".repeat(10_000)).length <= 4_000);
});

test("only Claude, the coder, gets the fix tools", () => {
  assert.ok(AGENTS.claude.tools.includes("github.update_pull_request") && AGENTS.claude.tools.includes("github.pr_checks"));
  for (const k of ["chatgpt", "gemini", "perplexity"] as const) assert.ok(!AGENTS[k].tools.includes("github.update_pull_request"), k);
});
