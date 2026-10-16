// ARN-119 (ARN-83 review finding F4): github.open_pull_request validates its branch and file paths before any
// GitHub call. Synthetic only: a fake fetch records requests; nothing reaches GitHub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PR_FILES, prBranch, prFiles, prPath, runTool, type ToolEnv } from "../src/tools.ts";

const REPO = "acme/app";
const ok = (path = "src/a.ts") => ({ path, content: "x" });

function rig(opts: { dryRun?: boolean; defaultBranch?: string } = {}) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const u = new URL(url);
    let json: unknown = {};
    if (u.pathname === `/repos/${REPO}`) json = { default_branch: opts.defaultBranch ?? "main" };
    else if (u.pathname.includes("/git/ref/heads/")) json = { object: { sha: "base-sha" } };
    else if (u.pathname.endsWith("/pulls")) json = { number: 7, html_url: "https://github.com/acme/app/pull/7" };
    else if (method === "GET" && u.pathname.includes("/contents/")) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(json), { status: 200 });
  }) as unknown as typeof fetch;
  const env: ToolEnv = {
    githubToken: "t", dryRun: opts.dryRun ?? false, f,
    policy: { allowPullRequests: true, allowedRepos: [REPO] },
    comment: async () => {}, requestApproval: async () => {},
  };
  const open = (input: Record<string, unknown>) =>
    runTool({ tool: "github.open_pull_request", input: { repo: REPO, title: "Add tests", branch: "acp/add-tests", files: [ok()], ...input } }, ["github.open_pull_request"], env);
  return { calls, open };
}

test("branch names must be acp/<short-name>", () => {
  for (const b of ["acp/add-tests", "acp/fix.1", "acp/a_b-c"]) assert.equal(prBranch(b), b);
  for (const b of [undefined, "", "main", "master", "develop", "feature/x", "acp/", "acp/Upper", "acp/a/b", "acp/a..b",
    "acp/x.lock", "acp/x.", "acp/-x", "acp/x y", "acp/x~1", "acp/x^", "acp/x:y", "acp/x\n", "refs/heads/acp/x", "acp/" + "a".repeat(64)]) {
    assert.throws(() => prBranch(b), /acp\/short-name/, JSON.stringify(b));
  }
});

test("file paths must be plain relative repository paths", () => {
  for (const p of ["src/a.ts", "README.md", "docs/runbooks/x-1.md", "a/b c/d.txt", "test/@scope/x+y.ts"]) assert.equal(prPath(p), p);
  for (const p of [undefined, "", "/etc/passwd", "../x", "src/../../x", "./x", "src//x", "src/", "a\\b", "x?ref=main", "x#y",
    "x%2F..", "x\u0000", "x\ny", " x", "x ", "a/ b", "a".repeat(256)]) {
    assert.throws(() => prPath(p), /path/, JSON.stringify(p));
  }
});

test("CI, ownership, git and secret files are protected", () => {
  for (const p of [".github/workflows/x.yml", ".GITHUB/CODEOWNERS", ".github", "CODEOWNERS", "docs/CODEOWNERS", ".gitlab-ci.yml",
    ".circleci/config.yml", ".git/config", "sub/.git/hooks/pre-commit", ".gitmodules", ".gitattributes", ".env", ".env.local",
    "app/.env.production", ".npmrc", "vercel.json"]) {
    assert.throws(() => prPath(p), /protected/, p);
  }
  for (const p of ["src/github.ts", "docs/env.md", "src/.environment.ts", "gitignore.md"]) assert.equal(prPath(p), p);
});

test("file lists are bounded and de-duplicated", () => {
  assert.throws(() => prFiles([]), /non-empty/);
  assert.throws(() => prFiles("x"), /non-empty/);
  assert.throws(() => prFiles([{ path: "a" }]), /path and content/);
  assert.throws(() => prFiles([null]), /path and content/);
  assert.throws(() => prFiles([ok("a.ts"), ok("A.ts")]), /more than once/);
  assert.throws(() => prFiles(Array.from({ length: MAX_PR_FILES + 1 }, (_, i) => ok(`f${i}.ts`))), /at most/);
  assert.equal(prFiles(Array.from({ length: MAX_PR_FILES }, (_, i) => ok(`f${i}.ts`))).length, MAX_PR_FILES);
});

test("invalid input is refused before any GitHub call, in dry run and live", async () => {
  for (const dryRun of [true, false]) {
    for (const bad of [{ branch: "main" }, { branch: "feature/x" }, { files: [ok(".github/workflows/pwn.yml")] }, { files: [ok("../x")] }]) {
      const { calls, open } = rig({ dryRun });
      const r = await open(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.match(r.output, /^ERROR: /);
      assert.equal(calls.length, 0, "no GitHub request");
    }
  }
});

test("the repo's real default branch is refused even when it is an acp/ name", async () => {
  const { calls, open } = rig({ defaultBranch: "acp/add-tests" });
  const r = await open({});
  assert.equal(r.ok, false);
  assert.match(r.output, /default branch/);
  assert.deepEqual(calls.map((c) => c.method), ["GET"], "only the repo lookup ran; no ref or file write");
});

test("a valid request opens a draft PR with encoded paths on a fresh acp/ branch", async () => {
  const { calls, open } = rig();
  const r = await open({ files: [ok("docs/a b.md"), ok("src/x+y.ts")] });
  assert.equal(r.ok, true, r.output);
  assert.match(r.output, /Opened draft PR #7/);
  const ref = calls.find((c) => c.url.endsWith("/git/refs"))!;
  assert.equal(ref.body.ref, "refs/heads/acp/add-tests");
  const puts = calls.filter((c) => c.method === "PUT").map((c) => new URL(c.url).pathname);
  assert.deepEqual(puts, [`/repos/${REPO}/contents/docs/a%20b.md`, `/repos/${REPO}/contents/src/x%2By.ts`]);
  const pr = calls.find((c) => c.url.endsWith("/pulls"))!;
  assert.deepEqual([pr.body.draft, pr.body.base, pr.body.head], [true, "main", "acp/add-tests"]);
});

test("the dry run of a valid request makes no GitHub call", async () => {
  const { calls, open } = rig({ dryRun: true });
  const r = await open({});
  assert.match(r.output, /DRY RUN: would open PR/);
  assert.equal(calls.length, 0);
});
