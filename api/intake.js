import { createHash, timingSafeEqual } from "node:crypto";

// Owner command/question intake. Scope is fixed here, never taken from the browser.
const LINEAR = "https://api.linear.app/graphql";
export const TEAM_ID = "faa75915-076f-479a-a3fb-92af2369e6c3"; // ARN
export const PROJECT_ID = "e8cf8cda-3347-4310-aea5-e6b7c7b95b4f"; // Arnexyia Launch Operations
export const COMMAND_MARKER = "Command issued from AI Command Post"; // must match src/orchestrator.ts
export const MAX_TEXT = 4000;
const MAX_BODY = 8192;
const LEADS = { gemini: "Gemini", claude: "Claude", chatgpt: "ChatGPT", perplexity: "Perplexity" };
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;

const error = (status, message) => ({ status, body: { error: message } });

function authenticate(req, env) {
  const provided = req.headers?.["x-acp-password"];
  if (typeof provided !== "string" || provided.length > 1024) return false;
  const a = Buffer.from(provided), b = Buffer.from(String(env.ACP_SITE_PASSWORD));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Writes must come from this site. Browsers always send Origin on POST.
function sameOrigin(req) {
  if (req.headers?.["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") return false;
  const origin = req.headers?.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers?.host; } catch { return false; }
}

// Deterministic issue UUID from the idempotency key: Linear rejects a second create with the same id,
// so a retried submit can't create a duplicate even across function instances.
export function issueIdFor(key) {
  const h = createHash("sha256").update("acp-intake:" + key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Neither intent may smuggle the engine marker: only the server adds it, and only for commands.
const neutralize = t => t.replaceAll(COMMAND_MARKER, "[command marker removed]");

export function buildIssue(intent, text, lead, at) {
  const clean = neutralize(text);
  const first = clean.split("\n")[0].slice(0, 120);
  const stamp = `- Submitted: ${at}\n- Channel: ACP owner console (site password verified; this is not proof of who typed it)`;
  if (intent === "question") {
    return {
      title: `[Question] ${first}`,
      description: `**Owner question (read-only)**\n\n${stamp}\n- Intent: question. Answer in comments only; this is not authority to run tools, open PRs or change anything.\n\n## Question\n\n${clean}`,
    };
  }
  const name = LEADS[lead] || LEADS.gemini;
  return {
    title: `[${name}] ${first}`,
    description: `**${COMMAND_MARKER}**\n\n- Lead AI: ${name}\n${stamp}\n- Intent: command\n\n## Command\n\n${clean}\n\n## Rules\n\n- The lead breaks this into sub-issues and assigns each to an AI by putting its name in [brackets] at the start of the title.\n- No merges to main, purchases, credential changes or customer-facing actions without owner approval.\n- Record evidence and handoff notes as comments on this issue.`,
  };
}

async function gql(env, f, query, variables) {
  const r = await f(LINEAR, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: String(env.LINEAR_API_KEY).trim().replace(/^Bearer\s+/i, "") },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000),
  });
  const payload = await r.json().catch(() => ({}));
  return { ok: r.ok && !payload.errors && payload.data, data: payload.data, errors: payload.errors || [] };
}

const CREATE = `mutation Intake($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`;
const FIND = `query IntakeFind($id: String!) { issue(id: $id) { id identifier url team { id } project { id } } }`;

// No model call, tool run or Eve execution happens here: this only files a Linear issue.
export async function handle(req, env, f = fetch, now = () => new Date()) {
  if (!env.ACP_SITE_PASSWORD || !env.LINEAR_API_KEY) return error(503, "Intake is not configured.");
  if (req.method !== "POST") return error(405, "POST only.");
  if (!authenticate(req, env)) return error(401, "Authentication required.");
  if (!sameOrigin(req)) return error(403, "Cross-site requests are not allowed.");
  let body;
  try {
    if (typeof req.body === "string" && Buffer.byteLength(req.body) > MAX_BODY) return error(413, "Request too large.");
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch { return error(400, "Invalid JSON."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return error(400, "Invalid request.");
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY) return error(413, "Request too large.");
  if (["team", "teamId", "project", "projectId", "title", "description", "lead"].some(k => Object.hasOwn(body, k))) {
    return error(400, "Scope and formatting are fixed by the server.");
  }
  const { intent, text, idempotencyKey } = body;
  if (intent !== "command" && intent !== "question") return error(400, "intent must be command or question.");
  if (typeof text !== "string" || !text.trim()) return error(400, "Text is required.");
  if (text.length > MAX_TEXT) return error(413, `Text is limited to ${MAX_TEXT} characters.`);
  if (typeof idempotencyKey !== "string" || !KEY_RE.test(idempotencyKey)) return error(400, "idempotencyKey is required (16-64 letters, digits, - or _).");

  const id = issueIdFor(idempotencyKey);
  const { title, description } = buildIssue(intent, text.trim(), String(env.ACP_DEFAULT_LEAD || "gemini").toLowerCase(), now().toISOString());
  try {
    const created = await gql(env, f, CREATE, { input: { id, teamId: TEAM_ID, projectId: PROJECT_ID, title, description, priority: 0 } });
    const issue = created.data?.issueCreate?.issue;
    if (created.ok && created.data.issueCreate.success && issue) {
      return { status: 201, body: { intent, duplicate: false, identifier: issue.identifier, url: issue.url } };
    }
    // Create failed: if an issue with this id already exists in scope, it was our earlier submit.
    const found = await gql(env, f, FIND, { id });
    const prior = found.data?.issue;
    if (found.ok && prior && prior.team?.id === TEAM_ID && prior.project?.id === PROJECT_ID) {
      return { status: 200, body: { intent, duplicate: true, identifier: prior.identifier, url: prior.url } };
    }
    return error(502, "Linear did not accept the request. Nothing was filed; you can retry with the same key.");
  } catch {
    return error(502, "Linear is unavailable. Retry with the same key; it will not create a duplicate.");
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const result = await handle(req, process.env);
  res.status(result.status).json(result.body);
}
