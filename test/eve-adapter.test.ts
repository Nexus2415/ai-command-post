import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, gate, eveOrigin, TIMEOUT_MS } from "../api/eve.js";

const env = { ACP_SITE_PASSWORD: "pw", ACP_EVE_ACTIVE: "true", ACP_EVE_BUDGET_USD: "5", EVE_BASE_URL: "https://eve.test", EVE_TOKEN: "secret-tok" };
const KEY = "abcdefghij0123456789";
const headers = { "x-acp-password": "pw", origin: "https://acp.test", host: "acp.test", "sec-fetch-site": "same-origin" };
const req = (body: object, h: object = headers) => ({ method: "POST", headers: h, body });
const cmd = (extra: object = {}) => req({ action: "dispatch", intent: "command", text: "do x", idempotencyKey: KEY, ...extra });

function fake(reply: () => Response | Promise<Response>) {
  const calls: { url: string; init: any }[] = [];
  const f = (async (url: string, init: any) => { calls.push({ url, init }); return reply(); }) as unknown as typeof fetch;
  return { f, calls };
}
const ok = () => new Response(JSON.stringify({ id: "s1" }), { status: 200 });

test("disabled by default and budget 0 blocks, with a next step and no call", async () => {
  const { f, calls } = fake(ok);
  for (const e of [{ ...env, ACP_EVE_ACTIVE: undefined }, { ...env, ACP_EVE_BUDGET_USD: undefined }, { ...env, ACP_EVE_BUDGET_USD: "0" }, { ...env, EVE_TOKEN: "" }, { ...env, EVE_BASE_URL: "" }]) {
    const r = await handle(cmd(), e, f);
    assert.equal(r.status, 503);
    assert.ok(["disabled", "blocked"].includes((r.body as any).status));
    assert.ok((r.body as any).nextStep);
  }
  assert.equal(gate({ ...env, ACP_EVE_ACTIVE: "false" })!.status, "disabled");
  assert.equal(calls.length, 0);
});

test("only a bare https origin from env is accepted", () => {
  assert.equal(eveOrigin({ EVE_BASE_URL: "http://eve.test" }), null);
  assert.equal(eveOrigin({ EVE_BASE_URL: "https://u:p@eve.test" }), null);
  assert.equal(eveOrigin({ EVE_BASE_URL: "https://eve.test/x" }), null);
  assert.equal(eveOrigin({ EVE_BASE_URL: "https://eve.test/" }), "https://eve.test");
});

test("password and same-origin are required", async () => {
  const { f, calls } = fake(ok);
  assert.equal((await handle(cmd(), { ...env, ACP_SITE_PASSWORD: "" }, f)).status, 503);
  assert.equal((await handle(req({}, { ...headers, "x-acp-password": "no" }), env, f)).status, 401);
  assert.equal((await handle(req({}, { ...headers, origin: "https://evil.test" }), env, f)).status, 403);
  assert.equal(calls.length, 0);
});

test("dispatch is unsupported even when fully configured, and sends nothing", async () => {
  const { f, calls } = fake(ok);
  for (const budget of ["5", "0.001"]) {
    const r = await handle(cmd({ url: "https://evil.test" }), { ...env, ACP_EVE_BUDGET_USD: budget }, f);
    assert.equal(r.status, 503);
    assert.equal((r.body as any).status, "unsupported");
    assert.equal((r.body as any).retry, false);
    assert.ok(!JSON.stringify(r.body).includes("secret-tok"));
  }
  assert.equal(calls.length, 0);
});

test("idempotency key is required and questions are never dispatched", async () => {
  const { f, calls } = fake(ok);
  assert.equal((await handle(cmd({ idempotencyKey: undefined }), env, f)).status, 400);
  assert.equal((await handle(cmd({ idempotencyKey: "short" }), env, f)).status, 400);
  const q = await handle(cmd({ intent: "question" }), env, f);
  assert.equal((q.body as any).status, "refused");
  assert.equal(calls.length, 0);
});

test("health uses only the fixed route with bearer auth and never claims execution readiness", async () => {
  const { f, calls } = fake(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const r = await handle(req({ action: "health", url: "https://evil.test" }), env, f);
  assert.deepEqual(r.body, { status: "reachable", httpStatus: 200, executionReady: false });
  assert.equal(calls[0]!.url, "https://eve.test/eve/v1/health");
  assert.equal(calls[0]!.init.method, "GET");
  assert.equal(calls[0]!.init.headers.authorization, "Bearer secret-tok");
  assert.ok(calls[0]!.init.signal instanceof AbortSignal);
  assert.ok(TIMEOUT_MS > 0);
});

test("malformed or unrecognised 2xx health is unknown, not ready", async () => {
  for (const body of ["not json", "{}", JSON.stringify({ ok: "yes" }), "null"]) {
    const { f } = fake(() => new Response(body, { status: 200 }));
    const r = await handle(req({ action: "health" }), env, f);
    assert.equal((r.body as any).status, "unknown");
    assert.equal((r.body as any).retry, false);
  }
});

test("health failures are unreachable or not_ready without upstream text", async () => {
  const { f } = fake(() => { throw new Error("ECONNRESET secret"); });
  const r = await handle(req({ action: "health" }), env, f);
  assert.equal((r.body as any).status, "unreachable");
  assert.ok(!JSON.stringify(r.body).includes("secret"));
  const { f: f2 } = fake(() => new Response("secret trace", { status: 500 }));
  const r2 = await handle(req({ action: "health" }), env, f2);
  assert.equal((r2.body as any).status, "not_ready");
  assert.ok(!JSON.stringify(r2.body).includes("secret"));
});
