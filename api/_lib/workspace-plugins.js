// Workspace plugins (Phase 1 step 4). One format that every tool-using model shares: a plugin is a name, a
// description, a readiness check and a list of tools, and each tool is a name, a description, a JSON Schema for
// its input and a run function. The chat loop turns these into each provider's own tool format.
//
// Phase 1 plugins only READ. Writes stay with the engine, behind its policy (src/policy.ts) and dry-run switch.
// There is deliberately no "fetch any URL" tool: a page could tell the model to send private data it read
// (Linear, GitHub) to an address of the page's choosing. Web search only talks to the search provider.
import { TEAM_ID, PROJECT_ID } from "./console-state.js";

const MAX_RESULT_CHARS = 8_000;
export class ToolError extends Error {}

const clip = (s) => (s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + "\n…(cut)" : s);
const str = (args, key, max = 500) => {
  const v = args?.[key];
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new ToolError(`"${key}" must be text of 1 to ${max} characters.`);
  return v.trim();
};

async function getJson(f, url, init, label) {
  let res;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new ToolError(`${label} didn't answer in time.`);
  }
  // Only the status goes back to the model, never the service's own error text.
  if (!res.ok) throw new ToolError(`${label} returned an error (${res.status}).`);
  const j = await res.json().catch(() => null);
  if (!j || typeof j !== "object") throw new ToolError(`${label} sent an invalid response.`);
  return j;
}

export function allowedRepos(env) {
  return String(env.ACP_GITHUB_REPOS ?? "").split(",").map((s) => s.trim()).filter((s) => /^[\w.-]+\/[\w.-]+$/.test(s));
}

function repoArg(env, args) {
  const repo = str(args, "repo", 200);
  if (!allowedRepos(env).includes(repo)) throw new ToolError(`Repo ${repo} is not on the allowed list (${allowedRepos(env).join(", ") || "none"}).`);
  return repo;
}

function gh(env, f, path) {
  return getJson(f, `https://api.github.com${path}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${String(env.GITHUB_TOKEN).trim()}`, "x-github-api-version": "2022-11-28" },
  }, "GitHub");
}

export const PLUGINS = Object.freeze({
  linear: {
    title: "Linear",
    description: "Read tasks on the Arnexyia Launch Operations board.",
    ready: (env) => Boolean(env.LINEAR_API_KEY),
    tools: [{
      name: "linear_search_issues",
      description: "List or search tasks on the Arnexyia Launch Operations Linear board. Returns id, status, owner and title.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Words to look for in titles. Leave out to list the most recently updated tasks." } } },
      async run(env, args, f) {
        const query = args?.query === undefined ? null : str(args, "query", 200);
        const j = await getJson(f, "https://api.linear.app/graphql", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: String(env.LINEAR_API_KEY).trim().replace(/^Bearer\s+/i, "") },
          body: JSON.stringify({
            query: `query($team:ID!,$project:ID!${query ? ",$q:String!" : ""}){ issues(first:30, orderBy:updatedAt, filter:{
              team:{ id:{ eq:$team } }, project:{ id:{ eq:$project } }${query ? ", title:{ containsIgnoreCase:$q }" : ""} }){
              nodes{ identifier title url state{ name } assignee{ name } team{ id } project{ id } } } }`,
            variables: { team: TEAM_ID, project: PROJECT_ID, ...(query ? { q: query } : {}) },
          }),
        }, "Linear");
        if (j.errors || !Array.isArray(j.data?.issues?.nodes)) throw new ToolError("Linear sent an invalid response.");
        const rows = j.data.issues.nodes
          .filter((n) => n?.team?.id === TEAM_ID && n?.project?.id === PROJECT_ID)
          .map((n) => `${n.identifier} [${n.state?.name ?? "?"}] ${n.assignee?.name ?? "unassigned"}: ${n.title} ${n.url}`);
        return rows.join("\n") || "No matching tasks.";
      },
    }],
  },
  github: {
    title: "GitHub",
    description: "Read files, issues and pull requests in the allowed repositories.",
    ready: (env) => Boolean(env.GITHUB_TOKEN) && allowedRepos(env).length > 0,
    tools: [{
      name: "github_read_file",
      description: "Read one file, or list a folder, in an allowed GitHub repository.",
      parameters: {
        type: "object", required: ["repo", "path"],
        properties: { repo: { type: "string", description: "owner/name" }, path: { type: "string", description: "File or folder path, e.g. README.md" } },
      },
      async run(env, args, f) {
        const repo = repoArg(env, args);
        const path = str(args, "path", 300);
        if (path.split("/").some((p) => p === ".." || p === ".")) throw new ToolError('"path" may not contain . or .. parts.');
        const j = await gh(env, f, `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`);
        if (Array.isArray(j)) return j.map((e) => `${e.type}\t${e.path}`).join("\n");
        if (j.encoding !== "base64" || typeof j.content !== "string") return "That file can't be shown as text.";
        return Buffer.from(j.content, "base64").toString("utf8");
      },
    }, {
      name: "github_search",
      description: "Search issues and pull requests in an allowed GitHub repository.",
      parameters: {
        type: "object", required: ["repo", "query"],
        properties: { repo: { type: "string", description: "owner/name" }, query: { type: "string" } },
      },
      async run(env, args, f) {
        const repo = repoArg(env, args);
        const q = str(args, "query", 200);
        const j = await gh(env, f, `/search/issues?q=${encodeURIComponent(`${q} repo:${repo}`)}&per_page=20`);
        return (j.items ?? []).map((i) => `#${i.number} [${i.state}] ${i.title} ${i.html_url}`).join("\n") || "No results.";
      },
    }],
  },
  web: {
    title: "Web search",
    description: "Search the web (Firecrawl).",
    ready: (env) => Boolean(env.FIRECRAWL_API_KEY),
    tools: [{
      name: "web_search",
      description: "Search the web. Returns titles, links and short descriptions.",
      parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
      async run(env, args, f) {
        const query = str(args, "query", 300);
        const j = await getJson(f, "https://api.firecrawl.dev/v2/search", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${String(env.FIRECRAWL_API_KEY).trim()}` },
          body: JSON.stringify({ query, limit: 5 }),
        }, "Web search");
        const web = j.data?.web ?? j.data ?? [];
        return (Array.isArray(web) ? web : [])
          .map((r) => `- ${r.title ?? ""} ${r.url ?? ""}\n  ${r.description ?? ""}`).join("\n") || "No results.";
      },
    }],
  },
});

export function pluginStatus(env) {
  return Object.fromEntries(Object.entries(PLUGINS).map(([k, p]) => [k, { title: p.title, description: p.description, ready: p.ready(env) }]));
}

// The tools of every ready plugin.
export function readyTools(env) {
  return Object.values(PLUGINS).filter((p) => p.ready(env)).flatMap((p) => p.tools);
}

// Runs one tool call. Failures come back as text for the model, so one bad call doesn't end the reply.
export async function runTool(env, tools, name, args, f = fetch) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { ok: false, text: `Unknown tool ${String(name).slice(0, 80)}.` };
  try {
    return { ok: true, text: clip(String(await tool.run(env, args && typeof args === "object" ? args : {}, f))) };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, text: e.message };
    return { ok: false, text: "The tool failed." };
  }
}
