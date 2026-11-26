import assert from "node:assert/strict";
import { test } from "node:test";
import { LEASE_MS, claimStoreFrom, memoryClaims, supabaseClaims } from "../src/claims.ts";

// Atomic claim store (src/claims.ts). A fake PostgREST that behaves like a primary key: first insert wins.
const clock = { now: new Date().toISOString() }; // rows are stamped "now", so they are fresh to the real clock
function fakeDb() {
  const rows = new Map<string, { executor: string; run: string; at: string }>();
  const seen: { method: string; url: string; prefer?: string; auth?: string }[] = [];
  const f = (async (url: any, init: any) => {
    const u = String(url);
    seen.push({ method: init.method, url: u, prefer: init.headers.prefer, auth: init.headers.authorization });
    if (init.method === "POST") {
      const { issue_id, executor, run_id } = JSON.parse(init.body);
      if (rows.has(issue_id)) return new Response("[]", { status: 201 }); // ignore-duplicates: nothing returned
      rows.set(issue_id, { executor, run: run_id, at: clock.now });
      return new Response(JSON.stringify([{ issue_id, executor, run_id }]), { status: 201 });
    }
    const id = decodeURIComponent(/issue_id=eq\.([^&]+)/.exec(u)![1]!);
    const r = rows.get(id);
    if (init.method === "PATCH") {
      const run = decodeURIComponent(/run_id=eq\.([^&]+)/.exec(u)![1]!);
      if (!r || r.run !== run) return new Response("[]");
      const b = JSON.parse(init.body);
      rows.set(id, { executor: r.executor, run: b.run_id, at: b.claimed_at });
      return new Response(JSON.stringify([{ issue_id: id }]));
    }
    return new Response(JSON.stringify(r ? [{ executor: r.executor, run_id: r.run, claimed_at: r.at }] : []));
  }) as typeof fetch;
  return { rows, seen, f };
}

test("the first engine to claim wins; later ones get the winner back", async () => {
  const db = fakeDb();
  const s = supabaseClaims("https://x.supabase.co/", "service", db.f, "run-a");
  assert.deepEqual(await s.acquire("iss-1", "acp:claude"), { won: true, holder: "acp:claude" });
  assert.deepEqual(await s.acquire("iss-1", "acp:claude"), { won: true, holder: "acp:claude" }, "the same run asking again still holds it");
  const other = supabaseClaims("https://x.supabase.co/", "service", db.f, "run-b");
  assert.deepEqual(await other.acquire("iss-1", "acp:chatgpt"), { won: false, holder: "acp:claude" });
  assert.deepEqual(await other.acquire("iss-1", "acp:claude"), { won: false, holder: "another acp:claude run" }, "a second engine run as the same AI stands down too");
  assert.equal(db.seen[0]!.url, "https://x.supabase.co/rest/v1/acp_claims?on_conflict=issue_id");
  assert.equal(db.seen[0]!.prefer, "resolution=ignore-duplicates,return=representation", "never overwrites the holder");
  assert.equal(db.seen[0]!.auth, "Bearer service");
});

test("racing engines: exactly one wins", async () => {
  const db = fakeDb();
  const r = await Promise.all(["acp:claude", "acp:claude", "acp:chatgpt"].map((e) => supabaseClaims("https://x.supabase.co", "k", db.f).acquire("iss-2", e)));
  assert.equal(r.filter((x) => x.won).length, 1);
});

test("a store error is an error, never a win", async () => {
  const s = supabaseClaims("https://x.supabase.co", "k", (async () => new Response(JSON.stringify({ message: "relation does not exist" }), { status: 404 })) as typeof fetch);
  await assert.rejects(s.acquire("iss-3", "acp:claude"), /claim store 404: relation does not exist/);
});

test("the store is on only with both settings, and the memory store has the same rule", async () => {
  assert.equal(claimStoreFrom({ ACP_WORKSPACE_DB_URL: "https://x.supabase.co" }), undefined);
  assert.ok(claimStoreFrom({ ACP_WORKSPACE_DB_URL: "https://x.supabase.co", ACP_WORKSPACE_DB_KEY: "k" }));
  const rows = new Map();
  assert.equal((await memoryClaims(rows).acquire("a", "acp:claude")).won, true);
  assert.equal((await memoryClaims(rows).acquire("a", "acp:claude")).won, false);
});

test("a later run of the same AI takes over only after the earlier run must have ended (retry next run)", async () => {
  const db = fakeDb();
  const t0 = Date.parse(clock.now);
  await supabaseClaims("https://x.supabase.co", "k", db.f, "run-1", () => t0).acquire("iss-4", "acp:claude");
  const run2 = supabaseClaims("https://x.supabase.co", "k", db.f, "run-2", () => t0 + 5 * 60_000);
  assert.equal((await run2.acquire("iss-4", "acp:claude")).won, false, "5 minutes later the first run may still be working");
  const run3 = supabaseClaims("https://x.supabase.co", "k", db.f, "run-3", () => t0 + LEASE_MS + 1);
  assert.equal((await run3.acquire("iss-4", "acp:claude")).won, true, "past the job's time limit, the next run retries");
  assert.equal(db.rows.get("iss-4")!.run, "run-3");
  const other = supabaseClaims("https://x.supabase.co", "k", db.f, "run-4", () => t0 + 10 * LEASE_MS);
  assert.equal((await other.acquire("iss-4", "acp:chatgpt")).won, false, "another AI's claim never expires");
});
