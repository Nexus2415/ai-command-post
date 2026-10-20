import assert from "node:assert/strict";
import { test } from "node:test";
import { hasSitePassword, isCrossSite, isSameOrigin } from "../api/lib/site-auth.js";

// ARN-83 F6: the one shared copy of the site-password and origin checks used by every API route.
const req = (headers: Record<string, string>) => ({ headers: { host: "acp.example", ...headers } });

test("site password: exact match only, length-capped, and an unset password never matches", () => {
  const env = { ACP_SITE_PASSWORD: "correct horse" };
  assert.equal(hasSitePassword(req({ "x-acp-password": "correct horse" }), env), true);
  for (const p of ["correct hors", "correct horse ", "", "x".repeat(1025)]) assert.equal(hasSitePassword(req({ "x-acp-password": p }), env), false, p);
  assert.equal(hasSitePassword(req({}), env), false, "missing header");
  assert.equal(hasSitePassword({ headers: { "x-acp-password": ["correct horse"] } } as never, env), false, "non-string header");
  for (const unset of [{}, { ACP_SITE_PASSWORD: "" }]) assert.equal(hasSitePassword(req({ "x-acp-password": "" }), unset), false);
});

test("writes need a same-origin browser request; reads only refuse other sites", () => {
  const same = req({ origin: "https://acp.example", "sec-fetch-site": "same-origin" });
  const other = req({ origin: "https://evil.example" });
  const noOrigin = req({});
  const badOrigin = req({ origin: "not a url" });
  const crossFetch = req({ origin: "https://acp.example", "sec-fetch-site": "cross-site" });
  const sameSite = req({ origin: "https://acp.example", "sec-fetch-site": "same-site" });
  assert.deepEqual([same, other, noOrigin, badOrigin, crossFetch, sameSite].map(isSameOrigin), [true, false, false, false, false, false]);
  assert.deepEqual([same, other, noOrigin, badOrigin, crossFetch, sameSite].map(isCrossSite), [false, true, false, true, true, false]);
});
