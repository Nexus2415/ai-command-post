// Atomic claim store (ARN-62): one executor per task, decided by a database primary key instead of by who wrote a
// Linear comment first.
//
// A Linear comment is not a lock: two engines that read an issue before either writes can both claim it. With this
// store configured, ACP takes a row keyed by the issue id BEFORE writing its Linear claim. The database lets exactly
// one insert win; every other engine gets the winner back and stands down. The Linear comment is still written, so
// people (and the dashboard) see who holds the task.
//
// Settings: ACP_WORKSPACE_DB_URL + ACP_WORKSPACE_DB_KEY (the workspace Supabase project and its service_role key,
// the same pair the site uses). Unset = Linear-only claims, as before. Set but unreachable = ACP doesn't claim and
// tries again next run: it never treats "couldn't ask" as "won".
//
// Table (db/workspace.sql): acp_claims(issue_id text primary key, executor, run_id, claimed_at).
// A claim belongs to one engine RUN, not just one AI: two runs both acting as Claude must still not both proceed.
// Each store instance gets its own run id. A later run of the SAME AI may take the row over only once the earlier
// run must have ended: the engine job is killed after 12 minutes, so a row older than LEASE_MS belongs to a finished
// run (that's how a task is retried next run). The takeover is a conditional update on the old run id, so two runs
// can't both take it. Another AI's row is never taken over.
import { randomUUID } from "node:crypto";
type Fetch = typeof fetch;
/** Longer than the engine job's 12-minute limit (.github/workflows/engine.yml timeout-minutes). */
export const LEASE_MS = 13 * 60_000;

export interface ClaimStore {
  /** Takes the claim for `executor` if nobody holds it. Returns who holds it afterwards (us, or the earlier winner). */
  acquire(issueId: string, executor: string): Promise<{ won: boolean; holder: string }>;
}

/** Supabase/PostgREST store. Atomic because issue_id is the primary key and duplicates are ignored, not overwritten. */
export function supabaseClaims(url: string, key: string, f: Fetch = fetch, runId: string = randomUUID(), now: () => number = Date.now): ClaimStore {
  const base = `${url.replace(/\/+$/, "")}/rest/v1/acp_claims`;
  const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };
  const call = async (u: string, init: RequestInit) => {
    const res = await f(u, { ...init, signal: AbortSignal.timeout(15_000) });
    const j: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`claim store ${res.status}${j?.message ? `: ${j.message}` : ""}`);
    return j;
  };
  return {
    async acquire(issueId, executor) {
      const inserted = await call(`${base}?on_conflict=issue_id`, {
        method: "POST",
        headers: { ...headers, prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify({ issue_id: issueId, executor, run_id: runId }),
      });
      if (Array.isArray(inserted) && inserted.length === 1) return { won: true, holder: executor };
      const id = encodeURIComponent(issueId);
      const rows = await call(`${base}?issue_id=eq.${id}&select=executor,run_id,claimed_at`, { method: "GET", headers });
      const row = Array.isArray(rows) ? rows[0] : undefined;
      if (typeof row?.executor !== "string") throw new Error("claim store gave no holder for a taken claim");
      if (row.executor === executor && row.run_id !== runId && Date.parse(row.claimed_at) < now() - LEASE_MS) {
        // Take over a finished run's row, only if it is still exactly that row (no other run got there first).
        const taken = await call(`${base}?issue_id=eq.${id}&run_id=eq.${encodeURIComponent(String(row.run_id))}`, {
          method: "PATCH",
          headers: { ...headers, prefer: "return=representation" },
          body: JSON.stringify({ run_id: runId, claimed_at: new Date(now()).toISOString() }),
        });
        if (Array.isArray(taken) && taken.length === 1) return { won: true, holder: executor };
        return { won: false, holder: `another ${executor} run` };
      }
      return holderOf(row.executor, row.run_id, executor, runId);
    },
  };
}

function holderOf(heldBy: string, heldRun: unknown, executor: string, runId: string) {
  // Both must match: inside one run, a task Claude holds is still not ChatGPT's.
  if (heldRun === runId && heldBy === executor) return { won: true, holder: executor };
  return { won: false, holder: heldBy === executor ? `another ${heldBy} run` : heldBy };
}

/** In-memory store with the same semantics; pass one `rows` map to several stores to model several engine runs. */
export function memoryClaims(rows = new Map<string, { executor: string; run: string; at: number }>(), now: () => number = Date.now): ClaimStore & { rows: typeof rows } {
  const runId = randomUUID();
  return {
    rows,
    async acquire(issueId, executor) {
      const held = rows.get(issueId);
      if (!held || (held.executor === executor && held.run !== runId && held.at < now() - LEASE_MS)) {
        rows.set(issueId, { executor, run: runId, at: now() });
        return { won: true, holder: executor };
      }
      return holderOf(held.executor, held.run, executor, runId);
    },
  };
}

/** The store from settings, or undefined when not configured (Linear-only claims). */
export function claimStoreFrom(env: Record<string, string | undefined>, f: Fetch = fetch): ClaimStore | undefined {
  const url = env["ACP_WORKSPACE_DB_URL"]?.trim(), key = env["ACP_WORKSPACE_DB_KEY"]?.trim();
  return url && key ? supabaseClaims(url, key, f) : undefined;
}
