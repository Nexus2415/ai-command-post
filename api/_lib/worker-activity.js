// Live worker activity for the Team map (ARN-163). Read-only projection of the rows engine runs write as they work
// (src/activity.ts) onto one state per AI: working, idle, blocked, completed or unknown.
//
// What counts as proof, and what never does:
// - "working" needs a heartbeat from the run that holds the task's claim (acp_claims run id = the fence), newer than
//   HEARTBEAT_TTL_MS, from a claim younger than the engine's lease. A Linear lane, a claim on its own or a
//   "started" row that has gone quiet are not proof of live work.
// - A terminal row (done, blocked, stopped, released) beats any heartbeat, whatever order rows arrive in, so a late
//   or replayed heartbeat can't bring a finished run back to life.
// - Rows from a run that lost the claim, rows dated in the future, malformed rows and duplicate sequence numbers
//   are dropped. A run that stopped writing without a terminal row reads "unknown", never "working" or "idle".
// - Any read failure, or no database configured, makes every AI "unknown". Nothing here is guessed.
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
/** Clock skew allowed between the engine and the site before a row counts as dated in the future. */
export const SKEW_MS = 60_000;
const ROW_LIMIT = 1000;
const CLAIM_LIMIT = 200;

const ISSUE_ID = /^[A-Za-z0-9-]{1,100}$/;
const IDENT = /^[A-Z][A-Z0-9]{0,9}-[1-9]\d{0,8}$/;
const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;

/** A row in the shape the engine writes, or null. */
export function validEvent(r) {
  if (!r || typeof r !== "object") return null;
  if (!str(r.run_id, 60) || !str(r.issue_id, 100) || !ISSUE_ID.test(r.issue_id) || !str(r.identifier, 40) || !IDENT.test(r.identifier)) return null;
  if (!Number.isInteger(r.seq) || r.seq < 1 || !KINDS.includes(r.kind) || !str(r.executor, 60)) return null;
  const agent = r.executor.startsWith("acp:") ? r.executor.slice(4) : "";
  if (!ENGINE_AGENTS.includes(agent)) return null;
  if (r.step != null && (!Number.isInteger(r.step) || r.step < 1)) return null;
  const at = typeof r.at === "string" && r.at.length <= 40 ? Date.parse(r.at) : NaN;
  if (!Number.isFinite(at)) return null;
  return { run: r.run_id, issue: r.issue_id, identifier: r.identifier, agent, executor: r.executor, seq: r.seq, kind: r.kind, step: r.step ?? null, at };
}

const unknownAll = (reason) => Object.fromEntries(ENGINE_AGENTS.map(a => [a, { state: "unknown", reason }]));

/** One attempt (a run on an issue) from its rows: working, completed, blocked, idle or unknown. */
function attemptState(rows, claim, nowMs) {
  const bySeq = new Map();
  for (const r of rows) {
    const had = bySeq.get(r.seq);
    if (had && (had.kind !== r.kind || had.at !== r.at)) return { state: "unknown", reason: "conflicting rows", at: Math.max(...rows.map(x => x.at)) };
    bySeq.set(r.seq, r);
  }
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const last = ordered[ordered.length - 1];
  const terminal = ordered.filter(r => TERMINAL[r.kind]).pop();
  const first = ordered[0];
  if (terminal) return { state: TERMINAL[terminal.kind], stopped: terminal.kind === "stopped", at: terminal.at, identifier: terminal.identifier };
  const claimedAt = Date.parse(claim.claimed_at);
  const live = nowMs - last.at <= HEARTBEAT_TTL_MS && Number.isFinite(claimedAt) && nowMs - claimedAt <= LEASE_MS;
  if (live) return { state: "working", at: last.at, since: first.at, step: last.step, identifier: last.identifier };
  return { state: "unknown", reason: "run went quiet without a result", at: last.at, identifier: last.identifier };
}

/**
 * The per-AI view. `rows` and `claims` come straight from the database; `ok` false means the read failed.
 * Returns { agents: { claude: {state, ...}, ... }, dropped } with a count of rows that weren't trusted.
 */
export function projectActivity({ ok, rows, claims, nowMs }) {
  if (!ok || !Array.isArray(rows) || !Array.isArray(claims)) return { agents: unknownAll("activity could not be read"), dropped: 0 };
  const claimOf = new Map();
  for (const c of claims) if (c && str(c.issue_id, 100) && str(c.executor, 60) && str(c.run_id, 60)) claimOf.set(c.issue_id, c);
  let dropped = 0;
  const attempts = new Map();
  for (const raw of rows) {
    const r = validEvent(raw);
    const claim = r && claimOf.get(r.issue);
    // The fence: only the run that holds the claim right now, as the same AI, speaks for the task.
    if (!r || r.at > nowMs + SKEW_MS || r.at < nowMs - WINDOW_MS || !claim || claim.run_id !== r.run || claim.executor !== r.executor) { dropped++; continue; }
    const k = r.run + "\u0000" + r.issue;
    if (!attempts.has(k)) attempts.set(k, { agent: r.agent, claim, rows: [] });
    attempts.get(k).rows.push(r);
  }
  const per = Object.fromEntries(ENGINE_AGENTS.map(a => [a, []]));
  for (const a of attempts.values()) per[a.agent].push(attemptState(a.rows, a.claim, nowMs));
  const agents = {};
  for (const a of ENGINE_AGENTS) {
    const list = per[a];
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

/** Reads the rows and the claims they are fenced by. Never throws; any failure is { ok: false }. */
async function readRows(env, f, nowMs) {
  const base = new URL("/rest/v1/", env.ACP_WORKSPACE_DB_URL).href;
  const key = String(env.ACP_WORKSPACE_DB_KEY).trim();
  const get = async (path) => {
    const res = await f(base + path, { method: "GET", headers: { apikey: key, authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error("activity read " + res.status);
    const j = await res.json();
    if (!Array.isArray(j)) throw new Error("activity read gave no list");
    return j;
  };
  const since = new Date(nowMs - WINDOW_MS).toISOString();
  const rows = await get(`acp_activity?select=run_id,issue_id,seq,identifier,executor,kind,step,at&at=gte.${encodeURIComponent(since)}&order=at.desc&limit=${ROW_LIMIT}`);
  const ids = [...new Set(rows.map(r => r && r.issue_id).filter(id => typeof id === "string" && ISSUE_ID.test(id)))].slice(0, CLAIM_LIMIT);
  const claims = ids.length ? await get(`acp_claims?select=issue_id,executor,run_id,claimed_at&issue_id=in.(${ids.join(",")})`) : [];
  return { ok: true, rows, claims };
}

/**
 * What /api/console adds to the overview: status "reported" with per-AI states, "unconfigured" when the site has no
 * workspace database, or "unavailable" when the read failed. The last two make every AI unknown.
 */
export async function readActivity(env, f = fetch, nowMs = Date.now()) {
  const readAt = new Date(nowMs).toISOString();
  const meta = { readAt, ttlMs: HEARTBEAT_TTL_MS };
  if (!workspaceConfigured(env)) return { status: "unconfigured", ...meta, agents: unknownAll("no activity source configured") };
  let read;
  try { read = await readRows(env, f, nowMs); } catch { read = { ok: false }; }
  const p = projectActivity({ ...read, nowMs });
  return { status: read.ok ? "reported" : "unavailable", ...meta, agents: p.agents, dropped: p.dropped };
}
