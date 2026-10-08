import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore plain JS module
import { checkClaims, expectedSubject, parseSessionCreated, prepareSessionRequest } from "../api/eve-oidc.js";
// @ts-ignore plain JS module
import { handle } from "../api/eve.js";

// Synthetic only: unsigned fake JWTs, no network, no real token source.
const prep = (o: any): Promise<any> => prepareSessionRequest(o);
const NOW = 2_000_000_000;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "RS256" })}.${b64(claims)}.c2ln`;
const SUB = "owner:arnexyia:project:ai-command-post:environment:production";
const good = { sub: SUB, aud: "https://vercel.com/arnexyia", exp: NOW + 600 };
const env = {
  ACP_EVE_ACTIVE: "true", ACP_EVE_BUDGET_USD: "1", EVE_BASE_URL: "https://eve.example.com",
  ACP_EVE_OIDC_TEAM: "arnexyia", ACP_EVE_OIDC_PROJECT: "ai-command-post", ACP_EVE_OIDC_ENVIRONMENT: "production",
};
const args = (over: Record<string, unknown> = {}) => ({ env, getToken: async () => jwt(good), message: "summarize ARN-58", operationId: "op_0123456789abcdef", nowSec: NOW, ...over });

test("prepares the exact 0.71.3 session request without sending it", async () => {
  const r = await prep(args());
  assert.equal(r.status, "prepared");
  assert.equal(r.sent, false);
  assert.equal(r.executionReady, false);
  assert.equal(r.request.url, "https://eve.example.com/eve/v1/session");
  assert.equal(r.request.method, "POST");
  assert.equal(r.request.headers.authorization, `Bearer ${jwt(good)}`);
  assert.equal(r.request.headers["x-vercel-trusted-oidc-idp-token"], jwt(good));
  assert.deepEqual(JSON.parse(r.request.body), { message: "summarize ARN-58", operationId: "op_0123456789abcdef" });
});

test("serializing a prepared request never exposes the token", async () => {
  const r = await prep(args());
  const s = JSON.stringify(r);
  assert.ok(!s.includes(jwt(good).split(".")[1]!));
  assert.match(s, /\[redacted\]/);
});

test("fails closed on every missing gate, before asking for a token", async () => {
  let asked = 0;
  const getToken = async () => { asked++; return jwt(good); };
  const cases: [Record<string, string | undefined>, string][] = [
    [{ ACP_EVE_ACTIVE: "false" }, "disabled"],
    [{ ACP_EVE_BUDGET_USD: "0" }, "blocked"],
    [{ EVE_BASE_URL: "http://eve.example.com" }, "blocked"],
    [{ ACP_EVE_OIDC_ENVIRONMENT: "*" }, "blocked"],
    [{ ACP_EVE_OIDC_ENVIRONMENT: undefined }, "blocked"],
    [{ ACP_EVE_OIDC_PROJECT: "" }, "blocked"],
  ];
  for (const [over, status] of cases) {
    const r = await prep(args({ env: { ...env, ...over }, getToken }));
    assert.equal(r.status, status, JSON.stringify(over));
    assert.equal(r.request, undefined);
  }
  assert.equal(asked, 0);
  assert.equal((await prep(args({ getToken: undefined }))).status, "blocked", "no default token provider");
});

test("rejects questions, bad messages and bad operation ids", async () => {
  for (const over of [{ message: "[Question] what?" }, { message: "  " }, { message: "x".repeat(4001) }, { operationId: "short" }, { operationId: undefined }]) {
    assert.equal((await prep(args(over))).status, "invalid", JSON.stringify(over).slice(0, 60));
  }
});

test("a token for the wrong project, environment, team or time is never used", async () => {
  const bad = [
    { ...good, sub: "owner:arnexyia:project:other:environment:production" },
    { ...good, sub: "owner:arnexyia:project:ai-command-post:environment:preview" },
    { ...good, aud: "https://vercel.com/someone-else" },
    { ...good, exp: NOW + 10 },
    { aud: good.aud, exp: good.exp },
  ];
  for (const claims of bad) {
    const r = await prep(args({ getToken: async () => jwt(claims) }));
    assert.equal(r.status, "blocked", JSON.stringify(claims));
    assert.equal(r.request, undefined);
  }
  for (const t of ["not-a-jwt", "a.b", 42, `${b64({})}.!!!.x`]) assert.ok(checkClaims(t, expectedSubject(env)!, NOW));
  assert.equal((await prep(args({ getToken: async () => { throw new Error("no ctx"); } }))).status, "blocked");
  assert.equal(checkClaims(jwt({ ...good, aud: [good.aud, "x"] }), expectedSubject(env)!, NOW), null, "array audience ok");
});

test("only the strict 202 accepted shape counts; accepted is never completion", () => {
  const ok = { ok: true, sessionId: "s1", status: "accepted" };
  assert.deepEqual(parseSessionCreated(202, "s1", ok), { accepted: true, completed: false, sessionId: "s1" });
  assert.equal(parseSessionCreated(202, null, ok).accepted, true);
  for (const [st, h, b] of [[200, "s1", ok], [202, "s2", ok], [202, null, { ...ok, extra: 1 }], [202, null, { ...ok, sessionId: "" }], [202, null, { ...ok, status: "done" }], [202, null, null], [202, null, [ok]]] as const) {
    assert.deepEqual(parseSessionCreated(st, h, b), { accepted: false, outcome: "unknown", retry: false });
  }
});

test("dispatch through the HTTP handler is still unsupported and sends nothing, even with OIDC settings", async () => {
  let calls = 0;
  const f = async () => { calls++; return new Response("{}"); };
  const req = { method: "POST", headers: { host: "acp.example.com", origin: "https://acp.example.com", "x-acp-password": "pw", "sec-fetch-site": "same-origin", authorization: "Bearer browser", "x-vercel-trusted-oidc-idp-token": "browser" }, body: { action: "dispatch", intent: "command", text: "go", idempotencyKey: "op_0123456789abcdef" } };
  const r = await handle(req, { ...env, ACP_SITE_PASSWORD: "pw", EVE_TOKEN: "t" }, f);
  assert.equal(r.status, 503);
  assert.equal(calls, 0);
});
