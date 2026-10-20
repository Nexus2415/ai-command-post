// Shared site-password and origin checks for the website's API routes (ARN-83 F6: one copy, so they can't drift).
import { timingSafeEqual } from "node:crypto";

// Constant-time check of the x-acp-password header. An unset site password never matches.
export function hasSitePassword(req, env) {
  const provided = req.headers?.["x-acp-password"];
  if (typeof provided !== "string" || provided.length > 1024 || !env.ACP_SITE_PASSWORD) return false;
  const a = Buffer.from(provided), b = Buffer.from(String(env.ACP_SITE_PASSWORD));
  return a.length === b.length && timingSafeEqual(a, b);
}

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
