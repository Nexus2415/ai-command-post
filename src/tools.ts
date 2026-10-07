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
    const path = str(input, "path");
    const ref = typeof input["ref"] === "string" ? `?ref=${encodeURIComponent(input["ref"])}` : "";
    const j = await gh(env, `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${ref}`);
    if (Array.isArray(j)) return j.map((e: any) => `${e.type}\t${e.path}`).join("\n");
    return Buffer.from(j.content ?? "", "base64").toString("utf8");
  },
  async "github.list_tree"(input, env) {
    const repo = str(input, "repo");
    const ref = typeof input["ref"] === "string" ? input["ref"] : "HEAD";
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
    const branch = str(input, "branch");
    const title = str(input, "title");
    const body = typeof input["body"] === "string" ? input["body"] : "";
    const files = input["files"];
    if (!Array.isArray(files) || !files.length) throw new Error('"files" must be a non-empty array of {path, content}');
    if (branch === "main" || branch === "master") throw new Error("Agents may not write to the default branch");
    if (env.dryRun) return `DRY RUN: would open PR "${title}" on ${repo} from ${branch} touching ${files.length} file(s)`;
    const repoInfo = await gh(env, `/repos/${repo}`);
    const base = repoInfo.default_branch as string;
    const baseRef = await gh(env, `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
    await gh(env, `/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }) });
    for (const file of files as { path: string; content: string }[]) {
      if (typeof file?.path !== "string" || typeof file?.content !== "string") throw new Error("Each file needs path and content");
      let sha: string | undefined;
      try {
        sha = (await gh(env, `/repos/${repo}/contents/${file.path}?ref=${encodeURIComponent(branch)}`)).sha;
      } catch {
        sha = undefined;
      }
      await gh(env, `/repos/${repo}/contents/${file.path}`, {
        method: "PUT",
        body: JSON.stringify({ message: `${title}\n\nOpened by AI Command Post`, content: Buffer.from(file.content).toString("base64"), branch, ...(sha ? { sha } : {}) }),
      });
    }
    const pr = await gh(env, `/repos/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title, head: branch, base, body, draft: true }) });
    return `Opened draft PR #${pr.number}: ${pr.html_url}`;
  },
  async "firecrawl.search"(input, env) {
    const query = str(input, "query");
    const j = await firecrawl(env, "/v2/search", { query, limit: Math.min(Number(input["limit"] ?? 5), 10) });
    const web = j.data?.web ?? j.data ?? [];
    return (Array.isArray(web) ? web : []).map((r: any) => `- ${r.title ?? ""} ${r.url}\n  ${r.description ?? ""}`).join("\n") || "No results";
  },
  async "firecrawl.scrape"(input, env) {
    const url = str(input, "url");
    if (!/^https:\/\//.test(url)) throw new Error("Only https URLs may be scraped");
    const j = await firecrawl(env, "/v2/scrape", { url, formats: ["markdown"], onlyMainContent: true });
    return j.data?.markdown ?? "";
  },
  async "linear.comment"(input, env) {
    const body = str(input, "body");
    await env.comment(body);
    return env.dryRun ? "DRY RUN: comment logged" : "Comment posted";
  },
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
