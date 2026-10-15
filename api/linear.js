// Website backend (Vercel serverless function). Legacy read-only adapter.
// The active dashboard uses /api/console; command creation uses /api/intake.
// This compatibility endpoint is fixed to the Arnexyia Launch Operations scope.
import { timingSafeEqual } from "node:crypto";
import { TEAM_ID, PROJECT_ID } from "./lib/console-state.js";

const LINEAR = "https://api.linear.app/graphql";
const MAX_BODY = 8192;
const error = (status, message) => ({ status, body: { error: message } });
const inScope = n => n?.team?.id === TEAM_ID && n?.project?.id === PROJECT_ID;

function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function crossSite(req) {
  if (req.headers?.["sec-fetch-site"] === "cross-site") return true;
  const origin = req.headers?.origin;
  if (!origin) return false; // Non-browser callers still need the site password.
  try { return new URL(origin).host !== req.headers?.host; } catch { return true; }
}

async function gql(env, f, query, variables) {
  const res = await f(LINEAR, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: String(env.LINEAR_API_KEY).trim().replace(/^Bearer\s+/i, "") },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.errors || !payload.data) throw new Error("Linear request failed");
  return payload.data;
}

const TOOLS = Object.freeze({
  async list_teams() {
    // Compatibility response without enumerating every team visible to the API key.
    return { teams: [{ name: "Arnexyia", key: "ARN" }] };
  },
  async list_issues(env, f) {
    const d = await gql(
      env, f,
      `query($team:ID!,$project:ID!){ issues(first:250, orderBy:updatedAt, filter:{
        team:{ id:{ eq:$team } }, project:{ id:{ eq:$project } }
      }){ nodes{ identifier title url priority priorityLabel updatedAt completedAt createdAt
          team{ id } project{ id } state{ name type } labels{ nodes{ name } } assignee{ name } }
        pageInfo{ hasNextPage } } }`,
      { team: TEAM_ID, project: PROJECT_ID },
    );
    if (!Array.isArray(d.issues?.nodes) || !d.issues?.pageInfo) throw new Error("Invalid response");
    const issues = d.issues.nodes.filter(inScope).map((n) => ({
      id: n.identifier, title: n.title, url: n.url,
      status: n.state?.name ?? "", statusType: n.state?.type ?? "",
      priority: { value: n.priority ?? 0, name: n.priorityLabel ?? "" },
      labels: (n.labels?.nodes ?? []).map((l) => l.name), assignee: n.assignee?.name ?? null,
      updatedAt: n.updatedAt, completedAt: n.completedAt, createdAt: n.createdAt,
    }));
    return { issues, hasNextPage: Boolean(d.issues.pageInfo.hasNextPage) };
  },
});

// Pure request handler, so tests can drive it with a fake fetch.
export async function handle(req, env, f = fetch) {
  if (!env.ACP_SITE_PASSWORD || !env.LINEAR_API_KEY) return error(503, "The website isn't configured yet.");
  if (!sameSecret(req.headers?.["x-acp-password"] ?? "", env.ACP_SITE_PASSWORD)) return error(401, "Wrong password");
  if (crossSite(req)) return error(403, "Cross-site requests are not allowed.");
  if (req.method !== "POST") return error(405, "POST only");

  let body;
  try {
    if (typeof req.body === "string" && Buffer.byteLength(req.body) > MAX_BODY) return error(413, "Request too large.");
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    if (!body || typeof body !== "object" || Array.isArray(body)) return error(400, "Invalid request.");
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY) return error(413, "Request too large.");
  } catch { return error(400, "Invalid JSON."); }

  if (typeof body.tool !== "string" || !Object.hasOwn(TOOLS, body.tool)) return error(400, "Unknown read tool");
  const args = body.args ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return error(400, "Invalid arguments.");
  // The documented website fallback still sends { team: "Arnexyia" }.
  // Accept only that redundant canonical value; the query remains bound to server IDs.
  const canonicalLegacyTeam =
    body.tool === "list_issues" && Object.hasOwn(args, "team") && args.team === "Arnexyia";
  if ((Object.hasOwn(args, "team") && !canonicalLegacyTeam) ||
      ["teamId", "project", "projectId", "url"].some(k => Object.hasOwn(args, k))) {
    return error(400, "Scope is fixed by the server.");
  }

  try {
    return { status: 200, body: await TOOLS[body.tool](env, f) };
  } catch {
    // Never relay upstream errors: they may contain internal data.
    return error(502, "Linear is unavailable. Retry without assuming task status changed.");
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const out = await handle(req, process.env);
  res.status(out.status).json(out.body);
}
