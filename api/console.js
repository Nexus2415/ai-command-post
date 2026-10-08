import { timingSafeEqual } from "node:crypto";
import { TEAM_ID, PROJECT_ID, overviewOf, projectIssue, safeLinearUrl } from "./lib/console-state.js";

const LINEAR = "https://api.linear.app/graphql";
const FIELDS = `id identifier title url priority updatedAt completedAt
  team { id } project { id } parent { identifier }
  state { name type } labels { nodes { name } } assignee { name }`;
const OVERVIEW = `query ConsoleOverview($team: ID!, $project: ID!) {
  issues(first: 250, orderBy: updatedAt, filter: {
    team: { id: { eq: $team } }, project: { id: { eq: $project } }
  }) { nodes { ${FIELDS} } pageInfo { hasNextPage } }
}`;
const THREAD = `query ConsoleThread($identifier: String!) {
  issue(id: $identifier) { ${FIELDS} description
    comments(last: 100) {
      nodes { id body createdAt updatedAt url user { name } }
      pageInfo { hasPreviousPage }
    }
  }
}`;
const error = (status, message) => ({ status, body: { error: message } });
const inScope = n => n?.team?.id === TEAM_ID && n?.project?.id === PROJECT_ID;

function authenticate(req, env) {
  const provided = req.headers?.["x-acp-password"];
  if (typeof provided !== "string" || provided.length > 1024) return false;
  const a = Buffer.from(provided), b = Buffer.from(env.ACP_SITE_PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

function crossSite(req) {
  if (req.headers?.["sec-fetch-site"] === "cross-site") return true;
  const origin = req.headers?.origin;
  if (!origin) return false; // Non-browser callers still need the site password.
  try { return new URL(origin).host !== req.headers?.host; } catch { return true; }
}

async function gql(env, f, query, variables) {
  const r = await f(LINEAR, {
    method: "POST", headers: {
      "content-type": "application/json",
      authorization: String(env.LINEAR_API_KEY).trim().replace(/^Bearer\s+/i, ""),
    },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000),
  });
  const payload = await r.json();
  if (!r.ok || payload.errors || !payload.data) throw new Error("Linear request failed");
  return payload.data;
}

// No issue mutation, comment mutation, model call or Eve execution exists in this endpoint.
export async function handle(req, env, f = fetch, now = () => new Date()) {
  if (!env.ACP_SITE_PASSWORD || !env.LINEAR_API_KEY) return error(503, "Console connection is not configured.");
  if (!authenticate(req, env)) return error(401, "Authentication required.");
  if (crossSite(req)) return error(403, "Cross-site requests are not allowed.");
  if (req.method !== "POST") return error(405, "POST only.");
  let body;
  try {
    if (typeof req.body === "string" && Buffer.byteLength(req.body) > 8192) return error(413, "Request too large.");
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return error(400, "Invalid request.");
    if (Buffer.byteLength(JSON.stringify(body)) > 8192) return error(413, "Request too large.");
  } catch { return error(400, "Invalid JSON."); }
  if (!["overview", "thread"].includes(body.action)) return error(400, "Unsupported read action.");
  // Scope is never accepted from the browser, even if the supplied ID happens to be valid.
  if (["team", "teamId", "project", "projectId", "url"].some(k => Object.hasOwn(body, k))) {
    return error(400, "Scope is fixed by the server.");
  }
  if (body.action === "thread" && (typeof body.identifier !== "string" || !/^ARN-[1-9]\d{0,8}$/.test(body.identifier))) {
    return error(400, "Invalid issue identifier.");
  }
  try {
    if (body.action === "overview") {
      const data = await gql(env, f, OVERVIEW, { team: TEAM_ID, project: PROJECT_ID });
      if (!Array.isArray(data.issues?.nodes) || !data.issues?.pageInfo) throw new Error("Invalid response");
      // Defense in depth: don't trust upstream filtering to authorize an out-of-scope row.
      const scoped = data.issues.nodes.filter(inScope);
      return { status: 200, body: overviewOf(scoped, now().toISOString(), Boolean(data.issues.pageInfo.hasNextPage)) };
    }
    const data = await gql(env, f, THREAD, { identifier: body.identifier });
    if (!data.issue || !inScope(data.issue)) return error(404, "Issue not found in this operation.");
    if (!Array.isArray(data.issue.comments?.nodes)) throw new Error("Invalid comments response");
    return { status: 200, body: {
      issue: { ...projectIssue(data.issue), description: data.issue.description || "" },
      comments: data.issue.comments.nodes.map(c => ({
        id: c.id, body: c.body || "", author: c.user?.name || "Unknown",
        authorVerifiedAsAgent: false,
        createdAt: c.createdAt, updatedAt: c.updatedAt, url: safeLinearUrl(c.url),
      })),
      hasPreviousPage: Boolean(data.issue.comments.pageInfo?.hasPreviousPage),
      fetchedAt: now().toISOString(),
    } };
  } catch {
    // Upstream bodies may contain data or credentials: never relay them to the browser.
    return error(502, "Linear is unavailable. Retry without assuming task status changed.");
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const result = await handle(req, process.env);
  res.status(result.status).json(result.body);
}
