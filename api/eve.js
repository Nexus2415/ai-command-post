// Narrow server-side adapter to the Eve execution service (opsdesk-harmony internal/ai-command).
// Fails closed: off unless ACP_EVE_ACTIVE=true and ACP_EVE_BUDGET_USD > 0. The Eve origin and token come only
// from server env vars (EVE_BASE_URL, EVE_TOKEN); the browser never supplies a URL and never sees the token.
// Dispatch is unsupported until its contract, budget reservation and ownership claim exist (see DISPATCH_UNSUPPORTED).
// An ambiguous health answer (malformed 2xx) is reported as unknown, never as ready.
// Turning this on in a preview is not production activation, and this file never mints or requests tokens.
import { timingSafeEqual } from "node:crypto";

export const HEALTH_PATH = "/eve/v1/health"; // documented in HYBRID-ARCHITECTURE.md
export const DISPATCH_UNSUPPORTED = "Eve dispatch is not implemented: its route, auth and payload are unverified, there is no budget reservation, and no ownership claim yet (ARN-52).";
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

async function call(env, f, method, path) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const headers = { authorization: `Bearer ${String(env.EVE_TOKEN).trim()}` };
  try {
    const res = await f(eveOrigin(env) + path, { method, headers, signal: ctl.signal, redirect: "error" });
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
    if (!r.res.ok) return out(200, { status: "not_ready", httpStatus: r.res.status, executionReady: false });
    // Eve 0.71.3 client/health-schema.js (.strict()): exactly {ok:true, status:"ready", workflowId:<non-empty string>}. Anything else is unknown.
    // Reachable is transport only: execution readiness is never claimed while dispatch is unsupported.
    const j = await r.res.json().catch(() => null);
    const healthy = j && typeof j === "object" && !Array.isArray(j) && Object.keys(j).length === 3 && j.ok === true && j.status === "ready" && typeof j.workflowId === "string" && j.workflowId.length > 0;
    if (!healthy) return out(502, { status: "unknown", retry: false, reason: "Eve health answered with an unrecognised body.", executionReady: false });
    return out(200, { status: "reachable", httpStatus: r.res.status, executionReady: false });
  }

  if (body.action !== "dispatch") return out(400, { error: "Unknown action" });
  const intent = body.intent;
  if (intent === "question") return out(400, { status: "refused", reason: "Questions are answered in Linear comments and are never dispatched for tool execution.", retry: false });
  if (intent !== "command") return out(400, { error: "intent must be \"command\"" });
  const key = body.idempotencyKey;
  if (typeof key !== "string" || !KEY_RE.test(key)) return out(400, { error: "idempotencyKey is required (16-64 of A-Z a-z 0-9 _ -)" });
  // Dispatch stays off whatever the env flags say, and no request is sent. Turning it on needs all of:
  // a verified, version-pinned Eve dispatch contract; a server-side budget reservation and ledger;
  // and an ownership claim so ACP and Eve can't both run one command (ARN-52).
  return out(503, { status: "unsupported", retry: false, reason: DISPATCH_UNSUPPORTED, nextStep: "Wait for ARN-52 and a verified Eve contract; no flag or credential change enables this." });
}

export default async function handler(req, res) {
  const r = await handle(req, process.env);
  res.status(r.status).json(r.body);
}
