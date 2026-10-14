import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrokerAdapter, createManagerEventBrokerAdapter, type BrokerFunction, type ManagerBrokerFunction, type CommandBinding } from "../src/broker-adapter.ts";

const tenant = "11111111-1111-4111-8111-111111111111";
const claim = "22222222-2222-4222-8222-222222222222";
const attempt = "33333333-3333-4333-8333-333333333333";
const binding: CommandBinding = { tenantRef: tenant, commandKey: `${tenant}:task:review_result`, actionRef: claim,
  tariffRef: claim, maxInputTokens: 0, maxCachedInputTokens: 0, maxOutputTokens: 1, idempotencyKey: `${tenant}:event` };
const request = { tenantId: tenant, claimKey: binding.commandKey, idempotencyKey: binding.idempotencyKey,
  executor: "claude" as const, tariffId: "free", worstCaseMicros: 0 };
const admitted = { ok: true, created: true, claim_id: claim, attempt_id: attempt, fence: 1, reserved_micros: 0, idempotency_key: binding.idempotencyKey };
const status = { ok: true, claim_id: claim, attempt_id: attempt, fence: 1, operation_id: "op:synthetic", state: "claimed" };

test("raw adapter retains class dependency methods and their receiver", async () => {
  class Dependencies {
    async binding() { assert.equal(this, deps); return { ...binding, commandKey: "task:review_result" }; }
    async usageEvidence() { assert.equal(this, deps); return null; }
    async rpc(fn: BrokerFunction) {
      assert.equal(this, deps); assert.equal(fn, "broker_claim_and_reserve");
      return { ...admitted, operation_id: "op:synthetic" };
    }
  }
  const deps = new Dependencies(), b = createBrokerAdapter(deps);
  assert.equal((await b.claimAndReserve(request)).ok, true);
  assert.deepEqual(await b.settle(attempt, 0, "unused"), { ok: false, reason: "no_usage_evidence" });
});

test("manager-event adapter uses native event claim and independently confirms its exact fence", async () => {
  const calls: ManagerBrokerFunction[] = [];
  const b = createManagerEventBrokerAdapter({ binding: async () => binding, usageEvidence: async () => null,
    async rpc(fn, args) {
      calls.push(fn);
      if (fn === "broker_claim_manager_event") { assert.equal(args["p_event"], "event"); assert.equal(args["p_command_key"], binding.commandKey); return admitted; }
      assert.equal(fn, "broker_claim_status"); return status;
    } });
  assert.deepEqual(await b.claimAndReserve(request), { ok: true, claimId: claim, attemptId: attempt, fence: 1,
    operationId: "op:synthetic", created: true, idempotencyKey: binding.idempotencyKey });
  assert.deepEqual(calls, ["broker_claim_manager_event", "broker_claim_status"]);
  assert.deepEqual(await b.takeover(claim, 1, 0), { ok: false, reason: "not_reclaimable" });
  assert.equal(calls.length, 2);
});

test("manager-event adapter refuses misbinding, replay substitution, stale status and priced claims", async () => {
  for (const [over, response, st] of [
    [{ commandKey: "task:review_result" }, admitted, status],
    [{ idempotencyKey: `${tenant}:other` }, admitted, status],
    [{}, { ...admitted, idempotency_key: `${tenant}:other` }, status],
    [{}, admitted, { ...status, fence: 2 }],
    [{}, admitted, { ...status, state: "settled" }],
    [{}, { ...admitted, reserved_micros: 1 }, status],
  ] as const) {
    const b = createManagerEventBrokerAdapter({ binding: async () => ({ ...binding, ...over }), usageEvidence: async () => null,
      rpc: async fn => fn === "broker_claim_manager_event" ? response : st });
    assert.equal((await b.claimAndReserve(request)).ok, false);
  }
});
