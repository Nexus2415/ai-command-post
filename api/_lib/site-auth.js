// Shared sign-in, session and origin checks for the website's API routes (ARN-83 F6: one copy, so they can't drift).
//
// Two ways in, both checked here so every route accepts the same ones:
// - a browser session: after signing in with email + password, the server sets an HttpOnly cookie holding a signed,
//   expiring token. Page scripts never see the cookie or the password, and nothing is written to browser storage
//   (ARN-53). "Remember me" keeps the session for 30 days; without it the cookie ends when the browser closes.
// - the x-acp-password header, for scripts and tools that aren't browsers.
// The token is signed with a key derived from ACP_SITE_PASSWORD, so changing that password signs every device out.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "__Host-acp_session";
export const REMEMBER_DAYS = 30;
// A session without Remember me still expires on the server after 12 hours, even if the browser keeps the cookie.
const SHORT_HOURS = 12;
const DAY = 86400;

function sameText(provided, expected) {
  const a = Buffer.from(String(provided)), b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Constant-time check of the x-acp-password header. An unset site password never matches.
function hasPasswordHeader(req, env) {
  const provided = req.headers?.["x-acp-password"];
  if (typeof provided !== "string" || provided.length > 1024 || !env.ACP_SITE_PASSWORD) return false;
  return sameText(provided, env.ACP_SITE_PASSWORD);
}

// True when the request carries the site password or a valid signed-in session.
export function hasSitePassword(req, env, now = Date.now()) {
  return hasPasswordHeader(req, env) || readSession(req, env, now) !== null;
}

// ---- Sessions ----
const b64 = (s) => Buffer.from(s).toString("base64url");
const signingKey = (env) => createHmac("sha256", String(env.ACP_SITE_PASSWORD)).update("acp-session-v1").digest();
const sign = (env, payload) => createHmac("sha256", signingKey(env)).update(payload).digest("base64url");

export function makeSessionToken(env, email, remember, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const exp = iat + (remember ? REMEMBER_DAYS * DAY : SHORT_HOURS * 3600);
  const payload = b64(JSON.stringify({ v: 1, e: email, r: remember === true, iat, exp }));
  return payload + "." + sign(env, payload);
}

function cookieValue(req, name) {
  const raw = req.headers?.cookie;
  if (typeof raw !== "string" || raw.length > 8192) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// The signed-in session on this request ({ email, remember, exp }), or null. Unset password: never signed in.
export function readSession(req, env, now = Date.now()) {
  if (!env.ACP_SITE_PASSWORD) return null;
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token || token.length > 2048) return null;
  const dot = token.indexOf(".");
  if (dot < 1 || token.indexOf(".", dot + 1) !== -1) return null;
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  if (!sameText(sig, sign(env, payload))) return null;
  let s;
  try { s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!s || s.v !== 1 || typeof s.e !== "string" || !Number.isInteger(s.exp) || !Number.isInteger(s.iat)) return null;
  const t = Math.floor(now / 1000);
  if (s.exp <= t || s.iat > t + 300) return null;
  return { email: s.e, remember: s.r === true, iat: s.iat, exp: s.exp };
}

export function sessionCookie(token, remember) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict` + (remember ? `; Max-Age=${REMEMBER_DAYS * DAY}` : "");
}
export const clearedCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

// Sign in, sign out and "am I signed in?" for the pages. Returns { status, body, cookie? }.
// sign_in: the password is the site password. If ACP_OWNER_EMAIL is set, the email must match it (any case);
// if it isn't set, any well-formed email is accepted and only shown back to you.
export function handleAuth(req, env, body, now = Date.now()) {
  const out = (status, b, cookie) => ({ status, body: b, ...(cookie ? { cookie } : {}) });
  if (req.method !== "POST") return out(405, { error: "POST only" });
  if (!isSameOrigin(req)) return out(403, { error: "Cross-site requests are not allowed." });
  if (!env.ACP_SITE_PASSWORD) return out(503, { error: "The website isn't configured yet." });
  const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {};
  if (body.action === "sign_out") return out(200, { ok: true }, clearedCookie());
  if (body.action === "session") {
    const s = readSession(req, env, now);
    if (!s) return out(401, { error: "Sign in required." });
    // Remembered sessions renew themselves once they are more than a day old, so a device you use stays signed in.
    const renew = s.remember && Math.floor(now / 1000) - s.iat > DAY;
    return out(200, { email: s.email, remember: s.remember, expiresAt: new Date(s.exp * 1000).toISOString() },
      renew ? sessionCookie(makeSessionToken(env, s.email, true, now), true) : undefined);
  }
  // sign_in
  const email = typeof args.email === "string" ? args.email.trim().toLowerCase() : "";
  const password = typeof args.password === "string" ? args.password : "";
  if (!EMAIL.test(email) || email.length > 254) return out(400, { error: "Enter your email address." });
  if (!password || password.length > 1024) return out(400, { error: "Enter your password." });
  const owner = typeof env.ACP_OWNER_EMAIL === "string" ? env.ACP_OWNER_EMAIL.trim().toLowerCase() : "";
  // Both checks always run, so a wrong email and a wrong password take the same time and give the same answer.
  const emailOk = owner ? sameText(email, owner) : true;
  const passwordOk = sameText(password, env.ACP_SITE_PASSWORD);
  if (!emailOk || !passwordOk) return out(401, { error: "That email or password isn't right." });
  const remember = args.remember === true;
  return out(200, { email, remember }, sessionCookie(makeSessionToken(env, email, remember, now), remember));
}
export const AUTH_ACTIONS = Object.freeze(["sign_in", "sign_out", "session"]);

// Strict, for writes: the request must come from this site. Browsers always send Origin on POST.
export function isSameOrigin(req) {
  if (req.headers?.["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") return false;
  const origin = req.headers?.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers?.host; } catch { return false; }
}

// Lenient, for read-only routes: refuses browsers on another site but lets non-browser callers (no Origin)
// through, since they still need the site password.
export function isCrossSite(req) {
  if (req.headers?.["sec-fetch-site"] === "cross-site") return true;
  const origin = req.headers?.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers?.host; } catch { return true; }
}
