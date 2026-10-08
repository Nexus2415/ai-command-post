// ARN-58: inert preparation of an authenticated ACP-to-Eve session request (Eve 0.71.3, Vercel workload OIDC).
// Nothing here sends a request, mints a token or reads one from the browser. The handler in eve.js still answers
// dispatch with 503 unsupported; this module only describes, and tests, what a future dispatch would have to send.
//
// Contract (Perplexity research on ARN-51, installed Eve 0.71.3 source):
// - Token: getVercelOidcToken() from @vercel/oidc, called inside request context. It is injected here as getToken;
//   there is no default, so without explicit wiring the result is "blocked".
// - Expected subject: owner:<team>:project:<project>:environment:<env>, with an explicit environment (no wildcard).
// - Headers: Authorization: Bearer <jwt> (Eve route auth) and x-vercel-trusted-oidc-idp-token: <jwt> (Deployment
//   Protection Trusted Sources). Both carry the same token.
// - Route: POST /eve/v1/session (singular), JSON { message, operationId }. Success is HTTP 202
//   { ok: true, sessionId, status: "accepted" } plus x-eve-session-id. Accepted is not completion.
// Owner-only prerequisites this code cannot satisfy: Eve's vercelOidc({ subjects: [vercelSubject(...)] }) naming ACP,
// a Trusted Sources rule on the Eve project, an atomic budget reservation, and owner activation approval.
import { eveOrigin } from "./eve.js";

export const SESSION_PATH = "/eve/v1/session";
export const ENVIRONMENTS = ["production", "preview", "development"];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const OP_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_TEXT = 4000;
const blocked = (reason, nextStep) => ({ status: "blocked", sent: false, reason, nextStep });

// The single subject ACP's token must carry, from server env only. Null when anything is missing or wildcarded.
export function expectedSubject(env) {
  const team = String(env.ACP_EVE_OIDC_TEAM ?? ""), project = String(env.ACP_EVE_OIDC_PROJECT ?? ""), e = String(env.ACP_EVE_OIDC_ENVIRONMENT ?? "");
  if (!SLUG_RE.test(team) || !SLUG_RE.test(project) || !ENVIRONMENTS.includes(e)) return null;
  return { team, sub: `owner:${team}:project:${project}:environment:${e}`, aud: `https://vercel.com/${team}` };
}

// Local shape check of the claims ACP is about to send. This is NOT verification and authorizes nothing: Eve verifies
// the signature and subject itself. It only stops ACP from sending a token for the wrong project or environment.
export function checkClaims(token, expected, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof token !== "string" || token.length > 8192) return "token is not a string";
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return "token is not a compact JWT";
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return "token claims are not JSON"; }
  if (!claims || typeof claims !== "object") return "token claims are not an object";
  if (claims.sub !== expected.sub) return "token subject does not match the configured ACP project and environment";
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expected.aud)) return "token audience does not match the configured team";
  if (typeof claims.exp !== "number" || claims.exp <= nowSec + 30) return "token is expired or about to expire";
  return null;
}

/**
 * Builds, but never sends, the session-create request. `getToken` is the only token source; nothing from the browser
 * request (headers, body principal, URLs) is read. The returned request redacts its token when serialized.
 */
export async function prepareSessionRequest({ env, getToken, message, operationId, nowSec }) {
  if (env.ACP_EVE_ACTIVE !== "true") return { status: "disabled", sent: false, reason: "ACP_EVE_ACTIVE is not \"true\"." };
  const budget = Number(env.ACP_EVE_BUDGET_USD ?? 0);
  if (!Number.isFinite(budget) || budget <= 0) return blocked("ACP_EVE_BUDGET_USD is 0 or unset.", "The owner sets an explicit positive budget after a budget reservation exists.");
  const origin = eveOrigin(env);
  if (!origin) return blocked("EVE_BASE_URL is missing or not a bare https origin.", "Set EVE_BASE_URL to the Eve deployment origin.");
  const expected = expectedSubject(env);
  if (!expected) return blocked("ACP_EVE_OIDC_TEAM, ACP_EVE_OIDC_PROJECT or ACP_EVE_OIDC_ENVIRONMENT is missing or invalid.", "Set the ACP team slug, project name and one explicit environment (production, preview or development).");
  if (typeof getToken !== "function") return blocked("No OIDC token provider is wired.", "Wire getVercelOidcToken() from @vercel/oidc inside the request handler once the owner approves.");
  if (typeof message !== "string" || !message.trim() || message.length > MAX_TEXT) return { status: "invalid", sent: false, reason: "message must be 1-4000 characters." };
  if (/^\s*\[question\]/i.test(message)) return { status: "invalid", sent: false, reason: "Owner questions are never dispatched." };
  if (typeof operationId !== "string" || !OP_RE.test(operationId)) return { status: "invalid", sent: false, reason: "operationId must be 16-64 URL-safe characters." };
  let token;
  try { token = await getToken(); } catch { return blocked("The OIDC token could not be obtained.", "Check that OIDC federation is enabled for the ACP project."); }
  const bad = checkClaims(token, expected, nowSec);
  if (bad) return blocked(bad, "Fix the ACP OIDC settings; never substitute a static key.");
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}`, "x-vercel-trusted-oidc-idp-token": token };
  const request = { url: origin + SESSION_PATH, method: "POST", headers, body: JSON.stringify({ message, operationId }), redirect: "error" };
  Object.defineProperty(request, "toJSON", { enumerable: false, value: () => ({ ...request, headers: { ...headers, authorization: "Bearer [redacted]", "x-vercel-trusted-oidc-idp-token": "[redacted]" } }) });
  return { status: "prepared", sent: false, executionReady: false, request };
}

// Strict reading of a session-create answer. Anything other than the exact 0.71.3 shape is "unknown" (never retried).
export function parseSessionCreated(status, headerSessionId, body) {
  const unknown = { accepted: false, outcome: "unknown", retry: false };
  if (status !== 202 || !body || typeof body !== "object" || Array.isArray(body)) return unknown;
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "ok,sessionId,status" || body.ok !== true || body.status !== "accepted") return unknown;
  if (typeof body.sessionId !== "string" || !body.sessionId) return unknown;
  if (headerSessionId != null && headerSessionId !== body.sessionId) return unknown;
  return { accepted: true, completed: false, sessionId: body.sessionId };
}
