import { decide, type PolicyContext } from "./policy.ts";

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
  firecrawlKey?: string;
  vercelToken?: string;
  dryRun: boolean;
  policy: PolicyContext;
  /** Posts a comment on the task being worked (linear.comment). */
  comment: (body: string) => Promise<void>;
  /** Called when a tool is refused for a red-tier reason, so the owner sees it. */
  requestApproval: (reason: string, call: ToolCall) => Promise<void>;
  f?: Fetch;
}

const MAX_OUTPUT = 12_000;
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
  if (PROTECTED.some((re) => re.test(p))) throw new Error(`File path "${p}" is protected: agents may not change CI, ownership, git, install-time or secret files`);
  return p;
}

export function prFiles(v: unknown): { path: string; content: string }[] {
  if (!Array.isArray(v) || !v.length) throw new Error('"files" must be a non-empty array of {path, content}');
  if (v.length > MAX_PR_FILES) throw new Error(`A pull request may touch at most ${MAX_PR_FILES} files`);
  const seen = new Set<string>();
  return v.map((f) => {
    if (!f || typeof f !== "object" || typeof f.content !== "string") throw new Error("Each file needs path and content");
    if (f.content.length > MAX_FILE_CHARS) throw new Error(`File content may be at most ${MAX_FILE_CHARS} characters`);
    const path = prPath(f.path);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error(`File path "${path}" appears more than once`);
    seen.add(key);
    return { path, content: f.content };
  });
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
  if (!env.githubToken) throw new Error("GITHUB_TOKEN is not set");
  const res = await (env.f ?? fetch)(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.githubToken}`,
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

const HANDLERS: Record<string, (input: Record<string, unknown>, env: ToolEnv) => Promise<string>> = {
  async "github.read_file"(input, env) {
    const repo = str(input, "repo");
    const path = readPath(input["path"]);
    const ref = input["ref"] === undefined ? "" : `?ref=${encodeURIComponent(gitRef(input["ref"], ""))}`;
    const j = await gh(env, `/repos/${repo}/contents/${encodePath(path)}${ref}`);
    if (Array.isArray(j)) return j.map((e: any) => `${e.type}\t${e.path}`).join("\n");
    return Buffer.from(j.content ?? "", "base64").toString("utf8");
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
    const files = prFiles(input["files"]);
    if (env.dryRun) return `DRY RUN: would open PR "${title}" on ${repo} from ${branch} touching ${files.length} file(s)`;
    const repoInfo = await gh(env, `/repos/${repo}`);
    const base = repoInfo.default_branch as string;
    if (typeof base !== "string" || !base || base === branch) throw new Error("Agents may not write to the default branch");
    const baseRef = await gh(env, `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
    // Creating the ref fails if the branch already exists, so an agent can never write onto someone else's branch.
    await gh(env, `/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }) });
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
        body: JSON.stringify({ message: `${title}\n\nOpened by AI Command Post`, content: Buffer.from(file.content).toString("base64"), branch, ...(sha ? { sha } : {}) }),
      });
    }
    const pr = await gh(env, `/repos/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title, head: branch, base, body, draft: true }) });
    return `Opened draft PR #${pr.number}: ${pr.html_url}`;
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
    if (env.dryRun) return `DRY RUN: would fetch ${url}`;
    const j = await firecrawl(env, "/v2/scrape", { url, formats: ["markdown"], onlyMainContent: true });
    return j.data?.markdown ?? "";
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
  "github.read_file": '{"repo":"owner/name","path":"src/x.ts","ref?":"branch"} — read a file or list a directory',
  "github.list_tree": '{"repo":"owner/name","ref?":"branch"} — list every file path',
  "github.search_issues": '{"repo":"owner/name","query":"text"} — search issues and PRs',
  "github.open_pull_request":
    '{"repo":"owner/name","branch":"acp/short-name","title":"...","body":"...","files":[{"path":"...","content":"full new file content"}]} — open a DRAFT pull request; never merges',
  "firecrawl.search": '{"query":"text","limit?":5} — web search',
  "firecrawl.scrape": '{"url":"https://..."} — fetch one page as markdown',
  "linear.comment": '{"body":"markdown"} — post a progress note on your task',
  "vercel.list_deployments": '{"project?":"name or id","teamId?":"team_...","limit?":10} — list recent Vercel deployments (read-only)',
  "vercel.deployment_status": '{"id":"dpl_... or url","teamId?":"team_..."} — state and error of one deployment (read-only)',
};

export async function runTool(call: ToolCall, allowed: string[], env: ToolEnv): Promise<ToolResult> {
  if (!allowed.includes(call.tool)) return { ok: false, output: `Tool ${call.tool} is not available to this agent` };
  const handler = HANDLERS[call.tool];
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
