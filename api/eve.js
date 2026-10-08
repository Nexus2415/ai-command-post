// Narrow server-side adapter to the Eve execution service (opsdesk-harmony internal/ai-command).
// Fails closed: off unless ACP_EVE_ACTIVE=true and ACP_EVE_BUDGET_USD > 0. The Eve origin and token come only
// from server env vars (EVE_BASE_URL, EVE_TOKEN); the browser never supplies a URL and never sees the token.
// An ambiguous outcome (timeout, network error, 5xx) is reported as unknown and never retried automatically.
// Turning this on in a preview is not production activation, and this file never mints or requests tokens.
import { timingSafeEqual } from "node:crypto";

export const HEALTH_PATH = "/eve/v1/health"; // documented in HYBRID-ARCHITECTURE.md
export const SESSION_PATH = "/eve/v1/sessions"; // ASSUMPTION: not verified against the eve package source
export const TIMEOUT_MS = 15_000;
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_TEXT = 4000;

const out = (status, body) => ({ status, body });

function authenticate(req, env) {
  const provided = req.headers?.["x-acp-password"];
  if (typeof provided !== "string" || provided.length > 1024) return false;
  const a = Buffer.from(provided), b = Buffer.from(String(env.ACP_SITE_PASSWORD));
  return a.length === b.length && timingSafeEqual(a, b);
}

function sameOrigin(req) {
  if (req.headers?.["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") return false;
  const origin = req.headers?.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers?.host; } catch { return false; }
}

// Returns the fixed https origin or null. Paths, queries, credentials in the URL are rejected.
export function eveOrigin(env) {
  try {
    const u = new URL(String(env.EVE_BASE_URL || ""));
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
    return u.origin;
  } catch { return null; }
}

// Why the adapter can't run, or null when it may.
export function gate(env) {
  if (env.ACP_EVE_ACTIVE !== "true") return { status: "disabled", reason: "ACP_EVE_ACTIVE is not \"true\".", nextStep: "The owner sets ACP_EVE_ACTIVE=true on the server after approving Eve execution." };
  const budget = Number(env.ACP_EVE_BUDGET_USD ?? 0);
  if (!Number.isFinite(budget) || budget <= 0) return { status: "blocked", reason: "ACP_EVE_BUDGET_USD is 0 or unset.", nextStep: "The owner sets an explicit positive ACP_EVE_BUDGET_USD." };
  if (!eveOrigin(env)) return { status: "blocked", reason: "EVE_BASE_URL is missing or not a bare https origin.", nextStep: "Set EVE_BASE_URL to the Eve deployment origin, e.g. https://eve.example.com." };
  if (!env.EVE_TOKEN) return { status: "blocked", reason: "EVE_TOKEN is not configured.", nextStep: "The owner provisions a scoped Eve credential as the server env var EVE_TOKEN. This adapter does not create one." };
  return null;
}

async function call(env, f, method, path, key, payload) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const headers = { authorization: `Bearer ${String(env.EVE_TOKEN).trim()}` };
  if (key) headers["idempotency-key"] = key;
  if (payload) headers["content-type"] = "application/json";
  try {
    const res = await f(eveOrigin(env) + path, { method, headers, body: payload ? JSON.stringify(payload) : undefined, signal: ctl.signal, redirect: "error" });
    return { res };
  } catch {
    return { failed: true };
  } finally { clearTimeout(timer); }
}

export async function handle(req, env, f = fetch) {
  if (!env.ACP_SITE_PASSWORD) return out(503, { status: "blocked", reason: "ACP_SITE_PASSWORD is not set.", nextStep: "Set ACP_SITE_PASSWORD on the server." });
  if (!authenticate(req, env)) return out(401, { error: "Wrong password" });
  if (req.method !== "POST") return out(405, { error: "POST only" });
  if (!sameOrigin(req)) return out(403, { error: "Cross-origin request refused" });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; } catch { return out(400, { error: "Invalid JSON" }); }
  if (!body || typeof body !== "object") return out(400, { error: "Invalid body" });

  const blocked = gate(env);
  if (blocked) return out(503, blocked);

  if (body.action === "health") {
    const r = await call(env, f, "GET", HEALTH_PATH);
    if (r.failed) return out(502, { status: "unreachable", reason: "Eve health check did not answer." });
    return out(200, { status: r.res.ok ? "ready" : "not_ready", httpStatus: r.res.status });
  }

  if (body.action !== "dispatch") return out(400, { error: "Unknown action" });
  const intent = body.intent;
  if (intent === "question") return out(400, { status: "refused", reason: "Questions are answered in Linear comments and are never dispatched for tool execution.", retry: false });
  if (intent !== "command") return out(400, { error: "intent must be \"command\"" });
  const key = body.idempotencyKey;
  if (typeof key !== "string" || !KEY_RE.test(key)) return out(400, { error: "idempotencyKey is required (16-64 of A-Z a-z 0-9 _ -)" });
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_TEXT) return out(400, { error: `text is required (max ${MAX_TEXT} characters)` });
  const issue = typeof body.issue === "string" && /^ARN-\d{1,6}$/.test(body.issue) ? body.issue : undefined;

  const r = await call(env, f, "POST", SESSION_PATH, key, { intent: "command", text, issue, idempotencyKey: key, source: "ai-command-post" });
  const unknown = { status: "unknown", retry: false, idempotencyKey: key, reason: "Eve may or may not have run this. Check Eve/Linear before resubmitting with the same key." };
  if (r.failed || r.res.status >= 500) return out(502, unknown);
  if (r.res.status === 401 || r.res.status === 403) return out(502, { status: "blocked", retry: false, reason: "Eve refused the credential or the kill switch ARNEXYIA_MULTI_AI_ACTIVE is off.", nextStep: "The owner checks EVE_TOKEN scope and the Eve kill switch." });
  if (!r.res.ok) return out(502, { status: "rejected", retry: false, httpStatus: r.res.status, reason: "Eve rejected the request." });
  const j = await r.res.json().catch(() => ({}));
  const sessionId = typeof j?.id === "string" ? j.id.slice(0, 200) : typeof j?.sessionId === "string" ? j.sessionId.slice(0, 200) : null;
  return out(202, { status: "accepted", sessionId, idempotencyKey: key });
}

export default async function handler(req, res) {
  const r = await handle(req, process.env);
  res.status(r.status).json(r.body);
}
