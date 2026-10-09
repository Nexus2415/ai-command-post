// Website backend (Vercel serverless function). The dashboard page calls this instead of the Claude Linear connector.
// Locked by the ACP_SITE_PASSWORD env var; it refuses everything when that isn't set. Legacy read-only adapter. Command creation is handled exclusively by /api/intake.
import { timingSafeEqual } from "node:crypto";

const LINEAR = "https://api.linear.app/graphql";

function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function gql(env, f, query, variables) {
  const res = await f(LINEAR, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: String(env.LINEAR_API_KEY).trim().replace(/^Bearer\s+/i, "") },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.errors) throw new Error(j.errors?.[0]?.message || `Linear HTTP ${res.status}`);
  return j.data;
}

const TOOLS = {
  async list_teams(env, f) {
    const d = await gql(env, f, `{ teams{ nodes{ name key } } }`);
    return { teams: d.teams.nodes };
  },
  async list_issues(env, f, args) {
    const d = await gql(
      env, f,
      `query($n:String!){ issues(first:250, orderBy:updatedAt, filter:{ team:{ name:{ eq:$n } } }){
        nodes{ identifier title url priority priorityLabel updatedAt completedAt createdAt
          state{ name type } labels{ nodes{ name } } assignee{ name } }
        pageInfo{ hasNextPage } } }`,
      { n: String(args.team || "") },
    );
    const issues = d.issues.nodes.map((n) => ({
      id: n.identifier, title: n.title, url: n.url,
      status: n.state?.name ?? "", statusType: n.state?.type ?? "",
      priority: { value: n.priority ?? 0, name: n.priorityLabel ?? "" },
      labels: (n.labels?.nodes ?? []).map((l) => l.name), assignee: n.assignee?.name ?? null,
      updatedAt: n.updatedAt, completedAt: n.completedAt, createdAt: n.createdAt,
    }));
    return { issues, hasNextPage: d.issues.pageInfo.hasNextPage };
  },

};

// Pure request handler, so tests can drive it with a fake fetch.
export async function handle(req, env, f = fetch) {
  if (!env.ACP_SITE_PASSWORD || !env.LINEAR_API_KEY) return { status: 503, body: { error: "The website isn't configured yet (ACP_SITE_PASSWORD and LINEAR_API_KEY)." } };
  if (!sameSecret(req.headers["x-acp-password"] ?? "", env.ACP_SITE_PASSWORD)) return { status: 401, body: { error: "Wrong password" } };
  if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const tool = TOOLS[body.tool];
  if (!tool) return { status: 400, body: { error: `Unknown tool ${body.tool}` } };
  try {
    return { status: 200, body: await tool(env, f, body.args || {}) };
  } catch (e) {
    return { status: 502, body: { error: e instanceof Error ? e.message : String(e) } };
  }
}

export default async function handler(req, res) {
  const out = await handle(req, process.env);
  res.status(out.status).json(out.body);
}
