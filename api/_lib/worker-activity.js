// Live worker activity for the Team map (ARN-163). Read-only projection of the rows engine runs write as they work
// (src/activity.ts) onto one state per AI: working, idle, blocked, completed or unknown.
//
// What counts as evidence, and what never does:
// - "working" needs an admitted heartbeat ("step": written only after the stop switch and budget checks passed and
//   the model call is going out) from the run that holds the task's claim (acp_claims run id = the fence), newer than
//   HEARTBEAT_TTL_MS, from a valid claim younger than the engine's lease. A Linear lane, a claim on its own or a
//   "started" row are not proof of live work. "Working" is a recent observation, never a live connection: it is
//   shown with its heartbeat age and goes away by itself once that ages out.
// - A terminal row (done, blocked, stopped, released) beats any heartbeat, whatever order rows arrive in.
// - Rows from a run that lost the claim, rows dated in the future, malformed rows and duplicate sequence numbers are
//   dropped. A claim with a bad or future time, a claim that changed while it was being read, a live claim with no
//   rows, a run that went quiet, or a working run that Linear already shows as no longer in progress reads "unknown".
// - Reads are bounded and checked: claims are read before and after the rows, a full page means the read may be
//   incomplete, and any read failure or incomplete read makes every AI "unknown". Nothing here is guessed.
// Consistency bound: a terminal row written just after the read shows on the next refresh (at most a minute), and a
//   lost terminal row is caught by the Linear cross-check or ages out with the heartbeat (HEARTBEAT_TTL_MS).
// "idle" only means no engine run is working on this AI's tasks: work an AI does outside the engine isn't seen.
import { workspaceConfigured } from "./workspace-store.js";

export const ENGINE_AGENTS = Object.freeze(["claude", "chatgpt", "perplexity", "gemini"]);
export const KINDS = Object.freeze(["started", "step", "done", "blocked", "stopped", "released"]);
const TERMINAL = { done: "completed", blocked: "blocked", stopped: "blocked", released: "idle" };
/** Longest gap between two heartbeats of a live run: a 120 s model reply plus a 90 s tool call, plus slack. */
export const HEARTBEAT_TTL_MS = 4 * 60_000;
/** The engine job is killed after 12 minutes; a claim older than this belongs to a run that has ended (src/claims.ts). */
export const LEASE_MS = 13 * 60_000;
/** How long a finished run still shows as completed or blocked before the AI reads idle again. */
export const RECENT_MS = 2 * 60 * 60_000;
/** Rows older than this are not read at all. */
export const WINDOW_MS = 24 * 60 * 60_000;
/** Clock skew allowed between the engine and the site before a time counts as in the future. */
export const SKEW_MS = 60_000;
/** Page sizes. A full page means more rows may exist, so the read is treated as incomplete, never trimmed. */
export const ROW_LIMIT = 1000;
export const CLAIM_LIMIT = 1000;

const ISSUE_ID = /^[A-Za-z0-9-]{1,100}$/;
const IDENT = /^[A-Z][A-Z0-9]{0,9}-[1-9]\d{0,8}$/;
const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
const agentOf = executor => (typeof executor === "string" && executor.startsWith("acp:") && ENGINE_AGENTS.includes(executor.slice(4)) ? executor.slice(4) : null);
const time = v => (typeof v === "string" && v.length <= 40 ? Date.parse(v) : NaN);

/** A row in the shape the engine writes, or null. */
export function validEvent(r) {
  if (!r || typeof r !== "object") return null;
  if (!str(r.run_id, 60) || !str(r.issue_id, 100) || !ISSUE_ID.test(r.issue_id) || !str(r.identifier, 40) || !IDENT.test(r.identifier)) return null;
  if (!Number.isInteger(r.seq) || r.seq < 1 || !KINDS.includes(r.kind)) return null;
  const agent = agentOf(r.executor);
  if (!agent) return null;
  if (r.step != null && (!Number.isInteger(r.step) || r.step < 1)) return null;
  const at = time(r.at);
  if (!Number.isFinite(at)) return null;
  return { run: r.run_id, issue: r.issue_id, identifier: r.identifier, agent, executor: r.executor, seq: r.seq, kind: r.kind, step: r.step ?? null, at };
}

const unknownAll = (reason) => Object.fromEntries(ENGINE_AGENTS.map(a => [a, { state: "unknown", reason }]));
const NOT_STARTED = ["completed", "canceled", "duplicate", "unstarted", "backlog", "triage"];

/** One attempt (a run on an issue) from its rows: working, completed, blocked, idle or unknown. */
function attemptState(rows, claimedAt, nowMs, linearState) {
  const latestAt = Math.max(...rows.map(x => x.at));
  const bySeq = new Map();
  for (const r of rows) {
    const had = bySeq.get(r.seq);
    if (had && (had.kind !== r.kind || had.at !== r.at)) return { state: "unknown", reason: "conflicting activity rows", at: latestAt, identifier: r.identifier };
    bySeq.set(r.seq, r);
  }
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const last = ordered[ordered.length - 1];
  const terminal = ordered.filter(r => TERMINAL[r.kind]).pop();
  if (terminal) return { state: TERMINAL[terminal.kind], stopped: terminal.kind === "stopped", at: terminal.at, identifier: terminal.identifier };
  const fresh = nowMs - last.at <= HEARTBEAT_TTL_MS && nowMs - claimedAt <= LEASE_MS;
  if (!fresh) return { state: "unknown", reason: "run went quiet without a result", at: last.at, identifier: last.identifier };
  const beat = ordered.filter(r => r.kind === "step").pop();
  if (!beat) return { state: "unknown", reason: "run started; no model call admitted yet", at: last.at, identifier: last.identifier };
  // The board itself is a second witness: a task Linear shows as done, canceled or back in Todo isn't being worked.
  if (linearState && NOT_STARTED.includes(linearState)) return { state: "unknown", reason: "Linear no longer shows it in progress; no result row seen", at: last.at, identifier: last.identifier };
  return { state: "working", at: beat.at, since: ordered[0].at, step: beat.step, identifier: beat.identifier };
}

/**
 * The per-AI view of one snapshot. `ok` false or `complete` false makes every AI unknown. `changed` names issues
 * whose claim moved while the snapshot was read; `linear` optionally maps identifiers to Linear state types.
 * Returns { agents: { claude: {state, ...}, ... }, dropped } with a count of rows that weren't trusted.
 */
export function projectActivity({ ok, complete = true, rows, claims, changed, linear, nowMs }) {
  if (!ok || !Array.isArray(rows) || !Array.isArray(claims)) return { agents: unknownAll("activity could not be read"), dropped: 0 };
  if (!complete) return { agents: unknownAll("activity read was incomplete"), dropped: 0 };
  const moved = changed instanceof Set ? changed : new Set();
  const lin = linear instanceof Map ? linear : new Map();
  const claimOf = new Map(), attempts = [];
  for (const c of claims) {
    if (!c || !str(c.issue_id, 100) || !str(c.run_id, 60) || !str(c.executor, 60)) continue;
    const agent = agentOf(c.executor), at = time(c.claimed_at);
    // A claim with an unreadable or future time, or one that moved during the read, can't fence anything.
    const valid = Number.isFinite(at) && at <= nowMs + SKEW_MS && !moved.has(c.issue_id);
    claimOf.set(c.issue_id, { ...c, agent, at, valid });
    if (agent && !valid && (!Number.isFinite(at) || nowMs - at <= RECENT_MS)) {
      attempts.push({ agent, state: { state: "unknown", reason: moved.has(c.issue_id) ? "claim changed while it was read" : "claim time is invalid", at: Number.isFinite(at) ? Math.min(at, nowMs) : nowMs } });
    }
  }
  let dropped = 0;
  const groups = new Map();
  for (const raw of rows) {
    const r = validEvent(raw);
    const claim = r && claimOf.get(r.issue);
    // The fence: only the run that holds the claim right now, as the same AI, speaks for the task.
    if (!r || r.at > nowMs + SKEW_MS || r.at < nowMs - WINDOW_MS || !claim || !claim.valid || claim.run_id !== r.run || claim.executor !== r.executor) { dropped++; continue; }
    const k = r.run + "\u0000" + r.issue;
    if (!groups.has(k)) groups.set(k, { agent: r.agent, claim, rows: [] });
    groups.get(k).rows.push(r);
  }
  for (const g of groups.values()) attempts.push({ agent: g.agent, state: attemptState(g.rows, g.claim.at, nowMs, lin.get(g.rows[0].identifier)) });
  // A live claim with no rows from its run: something holds the task, but its activity can't be seen.
  for (const [issue, c] of claimOf) {
    if (c.agent && c.valid && nowMs - c.at <= LEASE_MS && !groups.has(c.run_id + "\u0000" + issue)) {
      attempts.push({ agent: c.agent, state: { state: "unknown", reason: "task is claimed but no activity was recorded", at: c.at } });
    }
  }
  const agents = {};
  for (const a of ENGINE_AGENTS) {
    const list = attempts.filter(x => x.agent === a).map(x => x.state);
    const working = list.filter(x => x.state === "working").sort((x, y) => y.at - x.at);
    if (working.length) {
      const w = working[0];
      agents[a] = { state: "working", issue: w.identifier, step: w.step, since: new Date(w.since).toISOString(), at: new Date(w.at).toISOString(), issues: working.map(x => x.identifier) };
      continue;
    }
    const latest = list.sort((x, y) => y.at - x.at)[0];
    if (!latest || nowMs - latest.at > RECENT_MS) { agents[a] = { state: "idle" }; continue; }
    agents[a] = { state: latest.state, ...(latest.identifier ? { issue: latest.identifier } : {}), at: new Date(latest.at).toISOString(),
      ...(latest.stopped ? { stopped: true } : {}), ...(latest.reason ? { reason: latest.reason } : {}) };
  }
  return { agents, dropped };
}

const claimKey = c => [c?.run_id, c?.executor, c?.claimed_at].join("\u0000");

/**
 * Reads one bounded snapshot: claims, then rows, then claims again. Claims are read by time (not by the rows'
 * issues), so a claim with no rows at all is seen too. Never throws; any failure is { ok: false }.
 */
export async function readSnapshot(env, f = fetch, nowMs = Date.now()) {
  if (!workspaceConfigured(env)) return { ok: false, configured: false };
  const base = new URL("/rest/v1/", env.ACP_WORKSPACE_DB_URL).href;
  const key = String(env.ACP_WORKSPACE_DB_KEY).trim();
  const get = async (path) => {
    const res = await f(base + path, { method: "GET", headers: { apikey: key, authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error("activity read " + res.status);
    const j = await res.json();
    if (!Array.isArray(j)) throw new Error("activity read gave no list");
    return j;
  };
  try {
    const claimSince = encodeURIComponent(new Date(nowMs - WINDOW_MS - LEASE_MS).toISOString());
    const claimPath = `acp_claims?select=issue_id,executor,run_id,claimed_at&claimed_at=gte.${claimSince}&order=claimed_at.desc&limit=${CLAIM_LIMIT}`;
    const before = await get(claimPath);
    const since = encodeURIComponent(new Date(nowMs - WINDOW_MS).toISOString());
    const rows = await get(`acp_activity?select=run_id,issue_id,seq,identifier,executor,kind,step,at&at=gte.${since}&order=at.desc&limit=${ROW_LIMIT}`);
    const after = await get(claimPath);
    const was = new Map(before.map(c => [c?.issue_id, claimKey(c)]));
    const changed = new Set(after.filter(c => c && was.has(c.issue_id) && was.get(c.issue_id) !== claimKey(c)).map(c => c.issue_id));
    const complete = before.length < CLAIM_LIMIT && after.length < CLAIM_LIMIT && rows.length < ROW_LIMIT;
    return { ok: true, configured: true, complete, rows, claims: after, changed };
  } catch {
    return { ok: false, configured: true };
  }
}

/**
 * What /api/console adds to the overview: status "reported" with per-AI states, "unconfigured" when the site has no
 * workspace database, "incomplete" when a page filled up, or "unavailable" when the read failed. All but
 * "reported" make every AI unknown. `linear` maps identifiers to Linear state types for the cross-check.
 */
export function activityReport(snap, nowMs, linear) {
  const meta = { readAt: new Date(nowMs).toISOString(), ttlMs: HEARTBEAT_TTL_MS };
  if (!snap || snap.configured === false) return { status: "unconfigured", ...meta, agents: unknownAll("no activity source configured") };
  const p = projectActivity({ ...snap, linear, nowMs });
  const status = !snap.ok ? "unavailable" : snap.complete === false ? "incomplete" : "reported";
  return { status, ...meta, agents: p.agents, dropped: p.dropped };
}

/** Snapshot and report in one call (no Linear cross-check). */
export async function readActivity(env, f = fetch, nowMs = Date.now(), linear) {
  return activityReport(await readSnapshot(env, f, nowMs), nowMs, linear);
}
