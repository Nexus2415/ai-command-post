import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ID } from "../api/lib/console-state.js";
import { Budget, LEDGER_TITLE, ledgerContent, ledgerFromContent, type LedgerState } from "../src/budget.ts";
import { loadConfig } from "../src/config.ts";
import { DryRunStore, LinearStore, type TaskStore } from "../src/linear.ts";
import { STATUS_TITLE } from "../api/lib/engine-status.js";
import { tick, type Deps } from "../src/orchestrator.ts";

// HANDOFF gap 2: the spend ledger also lives in a Linear project document, merged with the Actions cache copy.
const now = new Date("2026-10-20T12:00:00Z");
const entry = (at: string, usd = 0.01) => ({ at, agent: "claude" as const, issue: "ARN-1", inputTokens: 1, outputTokens: 1, usd });
const ledger = (month: string, ...entries: ReturnType<typeof entry>[]): LedgerState => ({ month, entries });

function withFile(state: unknown | null, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "acp-durable-"));
  const path = join(dir, "ledger.json");
  if (state !== null) writeFileSync(path, typeof state === "string" ? state : JSON.stringify(state));
  try { fn(path); } finally { rmSync(dir, { recursive: true }); }
}

test("the Linear copy survives a lost cache, and both copies are merged without double counting", () => {
  withFile(null, path => {
    const b = new Budget({ capUsd: 1, path, now, remote: ledger("2026-10", entry("2026-10-02T00:00:00Z", 0.2)) });
    assert.equal(b.ledgerProblem, null, "an evicted cache with a durable copy is not a loss");
    assert.equal(b.spentUsd(), 0.2);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).entries.length, 1, "the cache copy is rebuilt");
  });
  withFile(ledger("2026-10", entry("2026-10-01T00:00:00Z"), entry("2026-10-03T00:00:00Z")), path => {
    const b = new Budget({ capUsd: 1, path, now, remote: ledger("2026-10", entry("2026-10-01T00:00:00Z"), entry("2026-10-02T00:00:00Z")) });
    assert.deepEqual(b.snapshot().entries.map(e => e.at.slice(8, 10)), ["01", "02", "03"]);
    assert.ok(Math.abs(b.spentUsd() - 0.03) < 1e-9, "an entry in both copies counts once");
  });
  withFile(ledger("2026-10", entry("2026-10-05T00:00:00Z")), path => {
    const b = new Budget({ capUsd: 1, path, now, remote: ledger("2026-09", entry("2026-09-05T00:00:00Z", 5)) });
    assert.equal(b.spentUsd(), 0.01, "last month's durable copy doesn't count against this month");
  });
  withFile(null, path => {
    assert.equal(new Budget({ capUsd: 1, path, now, remote: ledger("2026-09", entry("2026-09-05T00:00:00Z")) }).spentUsd(), 0, "a new month starts at zero");
  });
});

test("an unreadable or future-dated Linear copy blocks paid calls, unless the cap is zero or the owner resets the month", () => {
  for (const remote of ["unreadable", { month: "2026-10", entries: "x" }, ledger("2027-01")]) {
    withFile(ledger("2026-10"), path => {
      const b = new Budget({ capUsd: 1, path, now, remote });
      assert.match(b.ledgerProblem ?? "", /Linear spend ledger/);
      assert.equal(b.check("claude", 10, 10).ok, false);
      assert.equal(new Budget({ capUsd: 0, path, now, remote }).ledgerProblem, null);
      assert.equal(new Budget({ capUsd: 1, path, now, remote, resetMonth: "2026-10" }).ledgerProblem, null);
    });
  }
  withFile(null, path => {
    assert.match(new Budget({ capUsd: 1, path, now, remote: null }).ledgerProblem ?? "", /missing/, "no durable copy yet: the F5 rule still applies");
  });
});

test("ledger documents round-trip, and the store reads none, a ledger, or an unreadable one", async () => {
  const state = ledger("2026-10", entry("2026-10-02T00:00:00Z"));
  assert.deepEqual(ledgerFromContent(ledgerContent(state)), state);
  assert.equal(ledgerFromContent("edited by hand"), undefined);
  let nodes: any[] = [];
  const calls: any[] = [];
  const f = (async (_u: any, init: any) => {
    const b = JSON.parse(init.body);
    calls.push(b);
    if (b.query.includes("documents(")) return Response.json({ data: { project: { documents: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } });
    if (b.query.includes("documentCreate")) return Response.json({ data: { documentCreate: { success: true, document: { id: "led-1" } } } });
    return Response.json({ data: { documentUpdate: { success: true } } });
  }) as typeof fetch;
  assert.equal(await new LinearStore("k", f).readLedger(), null);
  nodes = [{ id: "led-1", title: LEDGER_TITLE, content: ledgerContent(state), createdAt: "2026-10-01T00:00:00Z" }];
  assert.deepEqual(await new LinearStore("k", f).readLedger(), state);
  nodes = [{ id: "led-1", title: LEDGER_TITLE, content: "cleared", createdAt: "2026-10-01T00:00:00Z" }];
  assert.equal(await new LinearStore("k", f).readLedger(), "unreadable");
  calls.length = 0;
  await new LinearStore("k", f).saveLedger("new");
  assert.deepEqual(calls.at(-1).variables, { id: "led-1", input: { content: "new" } });
  assert.deepEqual(calls[0].variables, { p: PROJECT_ID, after: null });
  const dry = new DryRunStore(new LinearStore("k", f));
  await dry.saveLedger("x");
  assert.deepEqual(dry.log, ["would update the spend ledger document"]);
});

test("ARN-45: the store reads every document page and never treats an unread page as absent", async () => {
  const state = ledger("2026-10", entry("2026-10-02T00:00:00Z"));
  const hidden = { id: "led-1", title: LEDGER_TITLE, content: ledgerContent(state), createdAt: "2026-10-01T00:00:00Z" };
  const filler = Array.from({ length: 50 }, (_, i) => ({ id: "d" + i, title: "Doc " + i, createdAt: "2026-09-01T00:00:00Z" }));
  const store = (pages: any[]) => {
    const calls: any[] = [];
    const f = (async (_u: any, init: any) => {
      const b = JSON.parse(init.body);
      calls.push(b);
      if (b.query.includes("documentCreate")) return Response.json({ data: { documentCreate: { success: true, document: { id: "new" } } } });
      if (b.query.includes("documentUpdate")) return Response.json({ data: { documentUpdate: { success: true } } });
      const p = pages[calls.filter(c => c.query.includes("documents(")).length - 1];
      return p instanceof Response ? p : Response.json({ data: { project: { documents: p } } });
    }) as typeof fetch;
    return { s: new LinearStore("k", f), calls };
  };
  const twoPages = () => [
    { nodes: filler, pageInfo: { hasNextPage: true, endCursor: "c1" } },
    { nodes: [hidden], pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  // The ledger on page 2 is found, and saving updates it instead of creating a duplicate.
  const read = store(twoPages());
  assert.deepEqual(await read.s.readLedger(), state);
  assert.deepEqual(read.calls.map(c => c.variables.after), [null, "c1"]);
  const save = store(twoPages());
  await save.s.saveLedger("new");
  assert.ok(!save.calls.some(c => c.query.includes("documentCreate")), "an existing page-2 ledger is never duplicated");
  assert.deepEqual(save.calls.at(-1).variables, { id: "led-1", input: { content: "new" } });
  // A list that can't be read in full is never "absent": the read throws (the CLI records it as unreadable and
  // blocks paid calls) and no document is created.
  const incomplete: any[][] = [
    [{ nodes: filler }],
    [{ nodes: filler, pageInfo: null }],
    [{ nodes: filler, pageInfo: { hasNextPage: "false" } }],
    [{ nodes: filler, pageInfo: { hasNextPage: true, endCursor: null } }],
    [{ nodes: filler, pageInfo: { hasNextPage: true, endCursor: "c1" } }, new Response("{}", { status: 500 })],
    [{ nodes: filler, pageInfo: { hasNextPage: true, endCursor: "c1" } }, { nodes: "x", pageInfo: { hasNextPage: false } }],
    Array.from({ length: 10 }, (_, i) => ({ nodes: filler, pageInfo: { hasNextPage: true, endCursor: "c" + (i + 1) } })),
  ];
  for (const pages of incomplete) {
    const r = store(pages);
    await assert.rejects(r.s.readLedger());
    const w = store(pages);
    await assert.rejects(w.s.saveLedger("new"));
    await assert.rejects(w.s.publishStatus("status"));
    assert.ok(!w.calls.some(c => c.query.includes("documentCreate") || c.query.includes("documentUpdate")), "no write on an incomplete list");
    assert.ok(w.calls.filter(c => c.query.includes("documents(")).length <= 8, "page reads are bounded");
  }
  // Even a match on page 1 is not used when the rest of the list is unread: an older duplicate could be unseen.
  await assert.rejects(store([{ nodes: [hidden], pageInfo: { hasNextPage: true, endCursor: null } }]).s.readLedger());
  // A matching document without a usable id is malformed: no read result, and no create or update.
  for (const id of [undefined, null, "", 7]) {
    const bad = { ...hidden, id };
    for (const pages of [[{ nodes: [bad], pageInfo: { hasNextPage: false } }], [{ nodes: filler, pageInfo: { hasNextPage: true, endCursor: "c1" } }, { nodes: [bad], pageInfo: { hasNextPage: false } }]]) {
      await assert.rejects(store(pages).s.readLedger(), /without an id/);
      const w = store(pages);
      await assert.rejects(w.s.saveLedger("new"), /without an id/);
      const st = store(pages.map((p: any) => ({ ...p, nodes: p.nodes.map((n: any) => n.title === LEDGER_TITLE ? { ...n, title: STATUS_TITLE } : n) })));
      await assert.rejects(st.s.publishStatus("status"), /without an id/);
      assert.ok(![...w.calls, ...st.calls].some(c => c.query.includes("documentCreate") || c.query.includes("documentUpdate")), "no write for an id-less match");
    }
  }
  // Duplicates are ordered by creation time: the oldest wins across pages, and a duplicate without a valid date fails
  // closed (it would otherwise sort first) with no create or update.
  const newer = { ...hidden, id: "led-2", content: "newer copy", createdAt: "2026-10-05T00:00:00Z" };
  const dup = store([{ nodes: [newer], pageInfo: { hasNextPage: true, endCursor: "c1" } }, { nodes: [hidden], pageInfo: { hasNextPage: false } }]);
  assert.deepEqual(await dup.s.readLedger(), state);
  for (const createdAt of [undefined, null, "", "not a date", 5]) {
    const pages = [{ nodes: [hidden], pageInfo: { hasNextPage: true, endCursor: "c1" } }, { nodes: [{ ...newer, createdAt }], pageInfo: { hasNextPage: false } }];
    await assert.rejects(store(pages).s.readLedger(), /without valid creation dates/);
    const w = store(pages);
    await assert.rejects(w.s.saveLedger("new"), /without valid creation dates/);
    const st = store(pages.map((p: any) => ({ ...p, nodes: p.nodes.map((n: any) => ({ ...n, title: STATUS_TITLE })) })));
    await assert.rejects(st.s.publishStatus("status"), /without valid creation dates/);
    assert.ok(![...w.calls, ...st.calls].some(c => c.query.includes("documentCreate") || c.query.includes("documentUpdate")), "no write when duplicates can't be ordered");
  }
  // A single match needs no ordering, and a whitespace id is no id.
  assert.deepEqual(await store([{ nodes: [{ ...hidden, createdAt: undefined }], pageInfo: { hasNextPage: false } }]).s.readLedger(), state);
  await assert.rejects(store([{ nodes: [{ ...hidden, id: "  " }], pageInfo: { hasNextPage: false } }]).s.readLedger(), /without an id/);
  // Exactly DOC_PAGES reads before giving up.
  const capped = store(incomplete[6]!);
  await assert.rejects(capped.s.readLedger());
  assert.deepEqual(capped.calls.map(c => c.variables.after), [null, "c1", "c2", "c3"]);
});

test("an active run saves the trusted ledger to Linear; an untrusted one is never written", async () => {
  const run = async (budget: Budget, save: (c: string) => Promise<void>) => {
    const log: string[] = [];
    const store: TaskStore = {
      listOpenAndRecent: async () => [], getComments: async () => [], comment: async () => {}, setState: async () => {},
      createIssue: async () => { throw new Error("no writes expected"); }, saveLedger: save,
    };
    const d: Deps = { cfg: loadConfig({ ACP_ACTIVE: "true", ACP_DEFAULT_LEAD: "gemini" }), store, clients: {}, budget, log: l => log.push(l),
      toolEnv: () => { throw new Error("no tools expected"); } };
    const r = await tick(d);
    return { r, log };
  };
  const saved: string[] = [];
  await run(new Budget({ capUsd: 1, path: null, now, remote: ledger("2026-10", entry("2026-10-02T00:00:00Z")) }), async c => { saved.push(c); });
  assert.equal(saved.length, 1);
  assert.equal((ledgerFromContent(saved[0]!) as LedgerState).entries.length, 1);
  await run(new Budget({ capUsd: 1, path: null, now, remote: "unreadable" }), async c => { saved.push(c); });
  assert.equal(saved.length, 1, "an empty stand-in never overwrites the durable copy");
  const { r, log } = await run(new Budget({ capUsd: 0, path: null, now }), async () => { throw new Error("Linear 500"); });
  assert.deepEqual(r.errors, []);
  assert.ok(log.some(l => l.includes("spend ledger not saved to Linear: Linear 500")));
});
