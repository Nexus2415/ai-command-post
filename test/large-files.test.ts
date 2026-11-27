// ARN-148: the engine's coder can read long files in line ranges and change existing files with exact edits, so it
// is no longer limited to files small enough to re-send whole in one reply. Synthetic only: a fake fetch stands in
// for GitHub; nothing leaves the process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdits, lineRange, prFiles, runTool, sliceLines, MAX_READ_LINES, type ToolEnv } from "../src/tools.ts";

const REPO = "acme/app";
const BIG = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join("\n");
const SRC = "export const a = 1;\nexport const b = 2;\n";

function rig(opts: { dryRun?: boolean; files?: Record<string, string> } = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const files = opts.files ?? { "src/a.ts": SRC, "src/big.ts": BIG };
  const f = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const u = new URL(url);
    calls.push({ method, path: u.pathname + u.search, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (u.pathname === `/repos/${REPO}`) return Response.json({ default_branch: "main" });
    if (u.pathname.includes("/git/ref/heads/")) return Response.json({ object: { sha: "base-sha" } });
    if (u.pathname.endsWith("/pulls")) return Response.json({ number: 9, html_url: "https://github.com/acme/app/pull/9" });
    if (method === "GET" && u.pathname.includes("/contents/")) {
      const p = decodeURIComponent(u.pathname.split("/contents/")[1] ?? "");
      const onMain = u.searchParams.get("ref") === "main" || !u.searchParams.has("ref");
      if (onMain && files[p] !== undefined) return Response.json({ sha: "s", content: Buffer.from(files[p]).toString("base64") });
      return new Response("{}", { status: 404 });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  const env: ToolEnv = {
    githubToken: "t", dryRun: opts.dryRun ?? false, f,
    policy: { allowPullRequests: true, allowedRepos: [REPO] },
    comment: async () => {}, requestApproval: async () => {},
  };
  const open = (fileList: unknown) =>
    runTool({ tool: "github.open_pull_request", input: { repo: REPO, title: "Change", branch: "acp/change", files: fileList } }, ["github.open_pull_request"], env);
  const read = (input: Record<string, unknown>) => runTool({ tool: "github.read_file", input: { repo: REPO, ...input } }, ["github.read_file"], env);
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { calls, open, read, writes };
}

test("edits apply in order and each find must match exactly once", () => {
  assert.equal(applyEdits("a", SRC, [{ find: "= 1", replace: "= 10" }, { find: "= 2", replace: "= 20" }]), "export const a = 10;\nexport const b = 20;\n");
  assert.throws(() => applyEdits("a", SRC, [{ find: "= 3", replace: "x" }]), /Edit 1 .*not found/);
  assert.throws(() => applyEdits("a", SRC, [{ find: "export const", replace: "x" }]), /more than once/);
  // A later edit sees the text the earlier one produced.
  assert.throws(() => applyEdits("a", SRC, [{ find: "= 1", replace: "= 2" }, { find: "= 2", replace: "y" }]), /Edit 2 .*more than once/);
});

test("a file is either whole content or edits, never both or neither", () => {
  assert.deepEqual(prFiles([{ path: "src/a.ts", edits: [{ find: "x", replace: "" }] }]), [{ path: "src/a.ts", edits: [{ find: "x", replace: "" }] }]);
  for (const bad of [
    [{ path: "src/a.ts" }],
    [{ path: "src/a.ts", content: "x", edits: [{ find: "x", replace: "y" }] }],
    [{ path: "src/a.ts", edits: [] }],
    [{ path: "src/a.ts", edits: [{ find: "", replace: "y" }] }],
    [{ path: "src/a.ts", edits: [{ find: "x" }] }],
    [{ path: "src/a.ts", edits: Array.from({ length: 41 }, () => ({ find: "x", replace: "y" })) }],
  ]) assert.throws(() => prFiles(bad), Error, JSON.stringify(bad).slice(0, 80));
});

test("edits cannot reach protected files", () => {
  assert.throws(() => prFiles([{ path: "src/policy.ts", edits: [{ find: "x", replace: "y" }] }]), /protected/);
  assert.throws(() => prFiles([{ path: ".github/workflows/x.yml", edits: [{ find: "x", replace: "y" }] }]), /protected/);
});

test("live run: edited file is written as base plus edits", async () => {
  const { open, writes } = rig();
  const r = await open([{ path: "src/a.ts", edits: [{ find: "= 2", replace: "= 3" }] }, { path: "docs/new.md", content: "# New" }]);
  assert.equal(r.ok, true, r.output);
  const puts = writes().filter((c) => c.method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal(Buffer.from(puts[0]!.body.content, "base64").toString(), "export const a = 1;\nexport const b = 3;\n");
  assert.equal(Buffer.from(puts[1]!.body.content, "base64").toString(), "# New");
});

test("a missed edit writes nothing: no branch, no file, no PR", async () => {
  const { open, writes } = rig();
  const r = await open([{ path: "docs/new.md", content: "ok" }, { path: "src/a.ts", edits: [{ find: "nope", replace: "x" }] }]);
  assert.equal(r.ok, false);
  assert.match(r.output, /not found/);
  assert.equal(writes().length, 0);
});

test("editing a file that doesn't exist says to send it whole, and writes nothing", async () => {
  const { open, writes } = rig();
  const r = await open([{ path: "src/missing.ts", edits: [{ find: "x", replace: "y" }] }]);
  assert.equal(r.ok, false);
  assert.match(r.output, /Send the whole file/);
  assert.equal(writes().length, 0);
});

test("dry run checks edits against the real file but writes nothing", async () => {
  const good = rig({ dryRun: true });
  const r = await good.open([{ path: "src/a.ts", edits: [{ find: "= 1", replace: "= 5" }] }]);
  assert.equal(r.ok, true);
  assert.match(r.output, /DRY RUN.*1 edit\(s\) apply cleanly/);
  assert.equal(good.writes().length, 0);

  const bad = rig({ dryRun: true });
  const r2 = await bad.open([{ path: "src/a.ts", edits: [{ find: "= 9", replace: "x" }] }]);
  assert.equal(r2.ok, false);
  assert.equal(bad.writes().length, 0);

  // Whole-file-only dry runs still make no GitHub call at all, as before.
  const plain = rig({ dryRun: true });
  assert.equal((await plain.open([{ path: "a.md", content: "x" }])).ok, true);
  assert.equal(plain.calls.length, 0);
});

test("read_file pages through a long file by line range", async () => {
  const { read } = rig();
  const r = await read({ path: "src/big.ts", from: 1500, to: 1502 });
  assert.equal(r.output, "[lines 1500-1502 of 2000]\nline 1500\nline 1501\nline 1502");
  const capped = await read({ path: "src/big.ts", from: 10, to: 5000 });
  assert.match(capped.output, new RegExp(`^\\[lines 10-${10 + MAX_READ_LINES - 1} of 2000\\]`));
  const whole = await read({ path: "src/big.ts" });
  assert.match(whole.output, /read the rest with "from" and "to"/);
  const small = await read({ path: "src/a.ts" });
  assert.equal(small.output, SRC);
  assert.equal((await read({ path: "src/a.ts", from: 0 })).ok, false);
  assert.equal((await read({ path: "src/a.ts", from: 5, to: 2 })).ok, false);
});

test("line helpers", () => {
  assert.equal(lineRange({}), null);
  assert.deepEqual(lineRange({ from: 3 }), { from: 3, to: 3 + MAX_READ_LINES - 1 });
  assert.equal(sliceLines("a\nb", { from: 5, to: 6 }), "[file has 2 lines; nothing at line 5]");
});
