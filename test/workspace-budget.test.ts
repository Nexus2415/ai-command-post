import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceBudgetPort, executeReserved } from "../api/_lib/workspace-budget.js";
import { handleProduction, handle } from "../api/workspace.js";
import { createMemoryStore } from "../api/_lib/workspace-store.js";

const plan = { requestId: "00000000-0000-4000-8000-000000000001",
  threadId: "00000000-0000-4000-8000-000000000002", maximumMicros: 60,
  monthCapMicros: 100, threadCapMicros: 100 };
function setup() {
  const seen = new Set<string>();
  const settled = new Map<string, number>();
  let calls = 0;
  const port = {
    reserve: async (p: typeof plan) => {
      if (seen.has(p.requestId)) return "duplicate";
      seen.add(p.requestId); return "reserved";
    },
    settle: async (p: typeof plan, actual: number) => {
      settled.set(p.requestId, actual); return actual > p.maximumMicros ? "ceiling_violation" : "settled";
    },
  };
  const worker = {
    beforeDispatch: async () => true,
    dispatch: async () => { calls++; return { synthetic: true }; },
    verifyReceipt: async () => ({ requestId: plan.requestId, threadId: plan.threadId, actualMicros: 20 }),
  };
  return { port, worker, settled, seen, calls: () => calls };
}
test("reserved operation settles once and duplicate cannot dispatch", async () => {
  const s = setup();
  const results = await Promise.all([executeReserved(s.port, plan, s.worker), executeReserved(s.port, plan, s.worker)]);
  assert.equal(results.filter((r) => r.status === "settled").length, 1);
  assert.equal(results.filter((r) => r.reason === "duplicate").length, 1);
  assert.equal(s.calls(), 1); assert.equal(s.settled.get(plan.requestId), 20);
});
test("zero cap, invalid amounts, unknown RPC response or unavailable ledger never dispatch", async () => {
  const s = setup();
  for (const p of [{...plan, monthCapMicros: 0}, {...plan, maximumMicros: NaN}, {...plan, maximumMicros: 0.1}])
    assert.equal((await executeReserved(s.port, p, s.worker)).status, "refused");
  for (const reserve of [async () => "surprise", async () => { throw new Error("offline"); }])
    assert.equal((await executeReserved({...s.port,reserve}, plan, s.worker)).status, "unknown");
  assert.equal(s.calls(), 0); assert.equal(s.seen.size, 0);
});
test("lost execution, stop recheck, or unverified receipt retain hold and prevent replay", async () => {
  for (const patch of [
    {beforeDispatch: async () => false},
    {dispatch: async () => { throw new Error("timeout"); }},
    {verifyReceipt: async () => ({...plan, threadId: plan.requestId, actualMicros: 0})},
    {verifyReceipt: async () => ({...plan, actualMicros: NaN})},
  ]) {
    const s = setup();
    assert.equal((await executeReserved(s.port, plan, {...s.worker, ...patch})).status, "unknown");
    assert.equal(s.seen.size,1); assert.equal(s.settled.size,0);
    assert.equal((await executeReserved(s.port, plan, s.worker)).reason, "duplicate");
  }
});
test("overage recorded in full, result blocked; settlement outage never retries execution", async () => {
  const s = setup();
  const o = await executeReserved(s.port, plan, {...s.worker, verifyReceipt: async () => ({...plan, actualMicros: 61})});
  assert.equal(o.reason, "ceiling_violation"); assert.equal(s.settled.get(plan.requestId),61);
  const s2 = setup();
  const fail = {...s2.port, settle: async () => { throw new Error("lost settlement response"); }};
  assert.equal((await executeReserved(fail,plan,s2.worker)).status,"unknown");
  assert.equal((await executeReserved(fail,plan,s2.worker)).reason,"duplicate");
  assert.equal(s2.calls(),1);
});
test("RPC adapter binds identity and integer bounds; rejects malformed responses", async () => {
  const env = { ACP_WORKSPACE_DB_URL:"https://synthetic.invalid", ACP_WORKSPACE_DB_KEY:"synthetic" };
  const seen: {url:string, body:any}[] = [];
  const f = (async (url: any, init: any) => {
    seen.push({url:String(url), body:JSON.parse(init.body)});
    assert.equal(init.redirect,"error");
    return new Response(JSON.stringify([{decision:"reserved"}]));
  }) as typeof fetch;
  const port = createWorkspaceBudgetPort(env,f);
  assert.equal(await port.reserve(plan),"reserved");
  assert.deepEqual(seen[0],{url:"https://synthetic.invalid/rest/v1/rpc/ws_budget_reserve",
    body:{p_request:plan.requestId,p_thread:plan.threadId,p_micros:60,p_month_cap:100,p_thread_cap:100}});
  for (const body of [[], [{decision:true}], [{decision:"reserved"},{decision:"reserved"}]]) {
    const bad = createWorkspaceBudgetPort(env, (async () => new Response(JSON.stringify(body))) as typeof fetch);
    await assert.rejects(bad.reserve(plan));
  }
});

test("production HTTP gate rejects model execution regardless of positive caps or request-body overrides", async () => {
  const env = {
    ACP_SITE_PASSWORD: "synthetic-password", ACP_WORKSPACE_DB_URL: "https://synthetic.invalid",
    ACP_WORKSPACE_DB_KEY: "synthetic", OPENAI_API_KEY: "synthetic",
    ANTHROPIC_API_KEY: "synthetic", ACP_WORKSPACE_MONTHLY_BUDGET_USD: "100",
    ACP_WORKSPACE_THREAD_BUDGET_USD: "100",
  };
  const store = createMemoryStore();
  const p = await store.createProject("Synthetic");
  const t = await store.createThread(p.id, "Synthetic", "chatgpt");
  let calls = 0;
  const f = (async () => { calls++; throw new Error("unexpected network"); }) as typeof fetch;
  const headers = { "x-acp-password": env.ACP_SITE_PASSWORD, origin: "https://acp.example", host: "acp.example" };
  const req = (action: string, args: object = {}) => ({
    method: "POST", headers, body: { action, args, blockProviderExecution: false, verified: true },
  });
  for (const [action,args] of [
    ["chat",{threadId:t.id,content:"synthetic"}],
    ["chat",{threadId:t.id}],
    ["compare",{threadId:t.id,content:"synthetic",models:["chatgpt","claude"]}],
    ["roundtable",{threadId:t.id,step:"start",content:"synthetic"}],
    ["roundtable",{threadId:t.id,step:"critique"}],
    ["roundtable",{threadId:t.id,step:"synthesize"}],
    ["roundtable_estimate",{threadId:t.id,content:"synthetic"}],
  ] as const) {
    const out = await handleProduction(req(action,args),env,()=>store,{fetch:f});
    assert.equal(out.status,402,action);
    assert.match((out.body as any).error,/atomic budget admission/);
  }
  assert.equal(calls,0);
  assert.equal((await store.listMessages(t.id)).length,0);
  const status = await handleProduction(req("models",{threadId:t.id}),env,()=>store,{fetch:f});
  assert.equal(status.status,200);
  assert.equal((status.body as any).models.chatgpt.ready,false);
  assert.match((status.body as any).models.chatgpt.reason,/atomic budget admission/);
  const read = await handleProduction(req("get_thread",{threadId:t.id}),env,()=>store,{fetch:f});
  assert.equal(read.status,200);
  assert.equal(calls,0);
  // Default handler is also fail closed when no synthetic store is injected.
  const def = await handle(req("chat",{threadId:t.id,content:"synthetic"}),env);
  assert.equal(def.status,402);
});
