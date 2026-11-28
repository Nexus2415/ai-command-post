// Worker activity telemetry (ARN-163): what an engine run is doing on a task RIGHT NOW, written as it happens.
//
// A Linear lane or a claim says who owns a task, not that anyone is working on it. So the run that holds a task's
// claim (src/claims.ts) writes one small row per lifecycle step to acp_activity: started, a heartbeat once each
// model call has passed the stop switch and budget checks and is about to go out ("step"), and one terminal row (done, blocked, stopped, released). The Team map reads these back
// (api/_lib/worker-activity.js) and only animates an AI while a fresh heartbeat from the claim-holding run exists.
//
// Rules:
// - Rows carry the claim's run id (the fence). A row from a run that no longer holds the claim is ignored on read.
// - seq rises by one per (run, issue), and (run_id, issue_id, seq) is unique, so a retried write can't duplicate.
// - Telemetry never steers work: a failed write is logged and the task carries on. The reader shows "unknown"
//   when it can't read, and never guesses "working".
// - Same database and key as the claim store (ACP_WORKSPACE_DB_URL + ACP_WORKSPACE_DB_KEY). Unset = no telemetry.
type Fetch = typeof fetch;

export const ACTIVITY_KINDS = ["started", "step", "done", "blocked", "stopped", "released"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
const TERMINAL_KINDS: readonly ActivityKind[] = ["done", "blocked", "stopped", "released"];

export interface ActivityEvent {
  issueId: string;
  identifier: string;
  executor: string;
  runId: string;
  seq: number;
  kind: ActivityKind;
  step: number | null;
  at: string;
}

export interface ActivitySink {
  /** Records the next lifecycle row for this task. Never throws: telemetry must not stop or change work. */
  record(issue: { id: string; identifier: string }, executor: string, kind: ActivityKind, step?: number): Promise<void>;
}

/** Shared numbering: one rising seq per (issue) inside this run. */
function sequencer() {
  const seqs = new Map<string, number>();
  return (issueId: string) => {
    const n = (seqs.get(issueId) ?? 0) + 1;
    seqs.set(issueId, n);
    return n;
  };
}

/** Supabase/PostgREST sink. `runId` must be the claim store's run id, so reads can fence rows to the claim holder. */
export function supabaseActivity(url: string, key: string, runId: string, f: Fetch = fetch, now: () => number = Date.now, log: (l: string) => void = () => {}): ActivitySink {
  const endpoint = `${url.replace(/\/+$/, "")}/rest/v1/acp_activity?on_conflict=run_id,issue_id,seq`;
  const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", prefer: "resolution=ignore-duplicates,return=minimal" };
  const next = sequencer();
  let warned = false;
  return {
    async record(issue, executor, kind, step) {
      const row = {
        issue_id: issue.id, identifier: issue.identifier, executor, run_id: runId, seq: next(issue.id), kind,
        step: Number.isInteger(step) ? step : null, at: new Date(now()).toISOString(),
      };
      // A terminal row is what ends "working" before the heartbeat ages out, so it gets one retry. The unique key
      // (run_id, issue_id, seq) makes the retry harmless if the first write did land.
      const tries = TERMINAL_KINDS.includes(kind) ? 2 : 1;
      try {
        for (let i = 1; ; i++) {
          try {
            const res = await f(endpoint, { method: "POST", headers, body: JSON.stringify(row), signal: AbortSignal.timeout(5_000) });
            if (!res.ok) throw new Error(`activity store ${res.status}`);
            break;
          } catch (e) { if (i >= tries) throw e; }
        }
      } catch (e) {
        // Logged once per run: a missing table (migration not applied yet) shouldn't flood the run log.
        if (!warned) log(`activity telemetry not written (${(e as Error).message}); the Team map will show this AI as unknown, not working`);
        warned = true;
      }
    },
  };
}

/** In-memory sink with the same numbering, for tests. */
export function memoryActivity(runId: string, now: () => number = Date.now): ActivitySink & { events: ActivityEvent[] } {
  const events: ActivityEvent[] = [];
  const next = sequencer();
  return {
    events,
    async record(issue, executor, kind, step) {
      events.push({ issueId: issue.id, identifier: issue.identifier, executor, runId, seq: next(issue.id), kind, step: Number.isInteger(step) ? step! : null, at: new Date(now()).toISOString() });
    },
  };
}

/** The sink from settings, bound to the claim store's run id; undefined when the database or run id is missing. */
export function activitySinkFrom(env: Record<string, string | undefined>, runId: string | undefined, f: Fetch = fetch, log?: (l: string) => void): ActivitySink | undefined {
  const url = env["ACP_WORKSPACE_DB_URL"]?.trim(), key = env["ACP_WORKSPACE_DB_KEY"]?.trim();
  return url && key && runId ? supabaseActivity(url, key, runId, f, Date.now, log) : undefined;
}
