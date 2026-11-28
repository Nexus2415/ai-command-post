// Workspace storage (Phase 1): projects, threads and messages.
// Production uses the Command Post's own Supabase project over its REST API; tests use the memory store.
import { randomUUID } from "node:crypto";
import { CANDIDATE_THREADS, MESSAGES_PER_THREAD } from "./workspace-shared.js";

export const MODELS = Object.freeze(["claude", "chatgpt", "gemini", "perplexity"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (v) => typeof v === "string" && UUID.test(v);

const PROJECT_COLS = "id,name,created_at";
// Threads are read with "*" so the page keeps working before the `private` column exists (db/workspace.sql); a
// thread whose flag is missing or unreadable is reported as private: null, and sharing treats it as private.
const privacyOf = (t) => (t.private === true ? true : t.private === false ? false : null);
const thread = (t) => ({ id: t.id, project_id: t.project_id, title: t.title, model: t.model, created_at: t.created_at, updated_at: t.updated_at, private: privacyOf(t) });
// Notes are read with "*" too, so they keep working before the memory columns exist (db/workspace.sql). A note
// without them is the owner's own (every note was, before automatic memory).
const note = (n) => ({
  id: n.id, project_id: n.project_id, content: n.content, created_at: n.created_at,
  source: n.source === "ai" ? "ai" : "owner", model: n.model ?? null, thread_id: n.thread_id ?? null,
  // An AI-saved fact counts as waiting for review unless the flag is certainly false (fail closed).
  pending: n.source === "ai" ? n.pending !== false : n.pending === true,
  // A proposed correction names the note it changes; `forget` proposals remove it instead.
  replaces: n.replaces ?? null, forget: n.forget === true,
});
const CONTROL_COLS = "stopped,updated_at";
const CONNECTOR_COLS = "id,project_id,kind,name,spec,fingerprint,enabled,created_at";
const MESSAGE_COLS = "id,thread_id,role,content,model,input_tokens,output_tokens,cost_usd,created_at";
const FILE_INFO_COLS = "id,thread_id,name,mime,bytes,pages,created_at";
const inList = (ids) => `in.(${ids.join(",")})`;
const AGENT_COLS = "id,project_id,name,prompt,model,cadence,weekday,enabled,thread_id,thread_month,last_run_at,last_status,created_at";
const ACTION_COLS = "id,thread_id,kind,payload,fingerprint,status,proposed_by,result,result_url,created_at,expires_at,decided_at";

export class StoreError extends Error {}

// Both settings are needed, and the URL must be https so the service key never travels in the clear.
export function workspaceConfigured(env) {
  if (!env.ACP_WORKSPACE_DB_URL || !env.ACP_WORKSPACE_DB_KEY) return false;
  try { return new URL(env.ACP_WORKSPACE_DB_URL).protocol === "https:"; } catch { return false; }
}

export function createSupabaseStore(env, f = fetch) {
  const base = new URL("/rest/v1/", env.ACP_WORKSPACE_DB_URL).href;
  const key = String(env.ACP_WORKSPACE_DB_KEY).trim();
  async function call(method, path, body, prefer) {
    const res = await f(base + path, {
      method,
      headers: {
        apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json",
        ...(prefer ? { prefer } : method === "GET" ? {} : { prefer: "return=representation" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    // Never relay the database's error text: it can name internal objects.
    if (!res.ok) throw new StoreError(`Workspace storage returned ${res.status}`);
    const rows = await res.json().catch(() => null);
    if (!Array.isArray(rows)) throw new StoreError("Workspace storage returned an invalid response");
    return rows;
  }
  const one = (rows) => {
    if (rows.length !== 1) throw new StoreError("Workspace storage returned an invalid response");
    return rows[0];
  };
  return {
    listProjects: () => call("GET", `ws_projects?select=${PROJECT_COLS}&order=created_at.desc&limit=200`),
    getProject: async (id) => (await call("GET", `ws_projects?select=${PROJECT_COLS}&id=eq.${id}`))[0] ?? null,
    createProject: async (name) => one(await call("POST", `ws_projects?select=${PROJECT_COLS}`, { name })),
    listThreads: async (projectId) =>
      (await call("GET", `ws_threads?select=*&project_id=eq.${projectId}&order=updated_at.desc&limit=200`)).map(thread),
    getThread: async (id) => {
      const t = (await call("GET", `ws_threads?select=*&id=eq.${id}`))[0];
      return t ? thread(t) : null;
    },
    createThread: async (projectId, title, model) =>
      thread(one(await call("POST", `ws_threads?select=*`, { project_id: projectId, title, model }))),
    // Mark a thread private (hidden from every other thread's AI) or shared again. Needs the `private` column.
    setThreadPrivate: async (id, isPrivate) =>
      thread(one(await call("PATCH", `ws_threads?id=eq.${id}&select=*`, { private: isPrivate }))),
    // The project's OTHER threads that are certainly shared, with their newest messages, in ONE query so a thread
    // can't turn private between reading its flag and reading its messages. `private=is.false` excludes true and
    // null; a missing column makes the query fail, and the caller then shares nothing.
    sharedContext: (projectId, excludeThreadId) => call("GET",
      `ws_threads?select=id,project_id,title,updated_at,private,ws_messages(role,content,model,created_at)` +
      `&project_id=eq.${projectId}&id=neq.${excludeThreadId}&private=is.false` +
      `&order=updated_at.desc&limit=${CANDIDATE_THREADS}&ws_messages.order=created_at.desc&ws_messages.limit=${MESSAGES_PER_THREAD}`),
    listMessages: (threadId) =>
      call("GET", `ws_messages?select=${MESSAGE_COLS}&thread_id=eq.${threadId}&order=created_at.asc&limit=500`),
    addMessage: async (threadId, msg) =>
      one(await call("POST", `ws_messages?select=${MESSAGE_COLS}`, { thread_id: threadId, ...msg })),
    listNotes: async (projectId) =>
      (await call("GET", `ws_notes?select=*&project_id=eq.${projectId}&order=created_at.asc&limit=50`)).map(note),
    // `extra` ({ source, model, thread_id, pending }) needs the memory columns; the owner's own notes don't.
    addNote: async (projectId, content, extra = {}) =>
      note(one(await call("POST", `ws_notes?select=*`, { project_id: projectId, content, ...extra }))),
    // The owner edits a note, or keeps an AI-saved fact (pending: false).
    updateNote: async (noteId, patch) =>
      (await call("PATCH", `ws_notes?id=eq.${noteId}&select=*`, { ...patch, updated_at: new Date().toISOString() }))
        .map(note)[0] ?? null,
    deleteNote: async (noteId) => (await call("DELETE", `ws_notes?id=eq.${noteId}&select=id`)).length > 0,
    spend: async (threadId, since) => {
      const row = one(await call("POST", "rpc/ws_spend", { p_thread: threadId, p_since: since }));
      return { monthUsd: Number(row.month_usd) || 0, threadUsd: Number(row.thread_usd) || 0 };
    },
    // Connectors and custom tools from the Tools page (api/_lib/workspace-connectors.js).
    listConnectors: () => call("GET", `ws_connectors?select=${CONNECTOR_COLS}&order=created_at.asc&limit=100`),
    addConnector: async (c) => one(await call("POST", `ws_connectors?select=${CONNECTOR_COLS}`, c)),
    setConnectorEnabled: async (id, enabled) =>
      (await call("PATCH", `ws_connectors?id=eq.${id}&select=${CONNECTOR_COLS}`, { enabled }, "return=representation"))[0] ?? null,
    deleteConnector: async (id) => (await call("DELETE", `ws_connectors?id=eq.${id}&select=id`)).length > 0,
    // The "Stop everything" switch: one row. A missing row reads as stopped (fail closed).
    getControl: async () => (await call("GET", `ws_control?select=${CONTROL_COLS}&id=eq.1`))[0] ?? null,
    setControl: async (stopped) => one(await call("POST", `ws_control?select=${CONTROL_COLS}`,
      { id: 1, stopped, updated_at: new Date().toISOString() }, "resolution=merge-duplicates,return=representation")),
    // Images and PDFs (api/_lib/workspace-files.js). Ids are checked by the caller; every read is bound to the thread.
    addFile: async (f) => one(await call("POST", `ws_files?select=${FILE_INFO_COLS}`, f)),
    countFiles: async (threadId) => (await call("GET", `ws_files?select=id&thread_id=eq.${threadId}&limit=1000`)).length,
    fileInfo: (threadId, ids) => call("GET", `ws_files?select=${FILE_INFO_COLS}&thread_id=eq.${threadId}&id=${inList(ids)}`),
    getFiles: (threadId, ids) => call("GET", `ws_files?select=${FILE_INFO_COLS},data&thread_id=eq.${threadId}&id=${inList(ids)}`),
    // Scheduled agents (api/_lib/workspace-agents.js). A missing table means no agents: nothing runs.
    listAgents: (projectId) => call("GET", `ws_agents?select=${AGENT_COLS}&project_id=eq.${projectId}&order=created_at.asc&limit=50`),
    listEnabledAgents: () => call("GET", `ws_agents?select=${AGENT_COLS}&enabled=is.true&order=created_at.asc&limit=50`),
    countAgents: async () => (await call("GET", "ws_agents?select=id&limit=100")).length,
    getAgent: async (id) => (await call("GET", `ws_agents?select=${AGENT_COLS}&id=eq.${id}`))[0] ?? null,
    addAgent: async (a) => one(await call("POST", `ws_agents?select=${AGENT_COLS}`, a)),
    updateAgent: async (id, patch) => (await call("PATCH", `ws_agents?id=eq.${id}&select=${AGENT_COLS}`, patch, "return=representation"))[0] ?? null,
    deleteAgent: async (id) => (await call("DELETE", `ws_agents?id=eq.${id}&select=id`)).length > 0,
    // Claims a run in one conditional update: only a switched-on agent whose last run is older than `before`.
    // null means it is off, gone, or already claimed (a second cron call, a double click).
    // Checkpoints are read and written on their own, so agents keep working before the checkpoint columns exist.
    getAgentCheckpoint: async (id) => {
      const r = (await call("GET", `ws_agents?select=checkpoint,checkpoint_at&id=eq.${id}`))[0];
      return r?.checkpoint ? { text: r.checkpoint, at: r.checkpoint_at ?? null } : null;
    },
    listAgentCheckpoints: (projectId) => call("GET", `ws_agents?select=id,checkpoint,checkpoint_at&project_id=eq.${projectId}&limit=50`),
    setAgentCheckpoint: async (id, text, at) =>
      (await call("PATCH", `ws_agents?id=eq.${id}&select=id`, { checkpoint: text, checkpoint_at: text ? at : null }, "return=representation")).length > 0,
    claimAgentRun: async (id, before, at) => (await call("PATCH",
      `ws_agents?id=eq.${id}&enabled=is.true&or=${encodeURIComponent(`(last_run_at.is.null,last_run_at.lt."${before}")`)}&select=${AGENT_COLS}`,
      { last_run_at: at, last_status: "Running…" }, "return=representation"))[0] ?? null,
    // Approval gate (api/_lib/workspace-actions.js). A missing table means no proposals can be saved or approved.
    // ARN-164: immutable scope staging only. This RPC never grants execution or creates a goal.
    saveBuildScope: async (args) => one(await call("POST","rpc/ws_save_visual_scope",args)),
    listActions: (threadId) => call("GET", `ws_actions?select=${ACTION_COLS}&thread_id=eq.${threadId}&order=created_at.desc&limit=50`),
    getAction: async (id) => (await call("GET", `ws_actions?select=${ACTION_COLS}&id=eq.${id}`))[0] ?? null,
    addAction: async (a) => one(await call("POST", `ws_actions?select=${ACTION_COLS}`, a)),
    // Moves an action on only if it is still in status `from`, in one update: null means someone else got there first.
    moveAction: async (id, from, patch) =>
      (await call("PATCH", `ws_actions?id=eq.${id}&status=eq.${from}&select=${ACTION_COLS}`, patch, "return=representation"))[0] ?? null,
  };
}

// In-memory store with the same behaviour, for tests and local runs.
// `control` sets the stop switch: false (running, the default), true (stopped), or "unreadable" to fail the read.
// `shared` set to "unreadable" makes the shared-threads query fail, to prove nothing is shared then.
/** @param {{ control?: boolean | "unreadable", shared?: "unreadable" }} [opts] */
export function createMemoryStore({ control = false, shared = null } = {}) {
  const projects = [], threads = [], messages = [], notes = [], connectors = [], actions = [], files = [], agents = [];
  let ctl = control;
  let clock = Date.parse("2026-10-21T00:00:00Z");
  const now = () => new Date(clock++).toISOString();
  const byNewest = (k) => (a, b) => (a[k] < b[k] ? 1 : -1);
  return {
    listProjects: async () => [...projects].sort(byNewest("created_at")),
    getProject: async (id) => projects.find((p) => p.id === id) ?? null,
    createProject: async (name) => {
      const p = { id: randomUUID(), name, created_at: now() };
      projects.push(p);
      return p;
    },
    listThreads: async (projectId) => threads.filter((t) => t.project_id === projectId).sort(byNewest("updated_at")),
    getThread: async (id) => threads.find((t) => t.id === id) ?? null,
    createThread: async (projectId, title, model) => {
      const at = now();
      const t = { id: randomUUID(), project_id: projectId, title, model, created_at: at, updated_at: at, private: false };
      threads.push(t);
      return t;
    },
    setThreadPrivate: async (id, isPrivate) => {
      const t = threads.find((x) => x.id === id);
      if (!t) throw new StoreError("Workspace storage returned an invalid response");
      t.private = isPrivate;
      return { ...t };
    },
    // Same filter as the database query: other threads of the project whose flag is exactly false.
    sharedContext: async (projectId, excludeThreadId) => {
      if (shared === "unreadable") throw new StoreError("Workspace storage returned 400");
      return threads
        .filter((t) => t.project_id === projectId && t.id !== excludeThreadId && t.private === false)
        .sort(byNewest("updated_at")).slice(0, CANDIDATE_THREADS)
        .map((t) => ({
          id: t.id, project_id: t.project_id, title: t.title, updated_at: t.updated_at, private: t.private,
          ws_messages: messages.filter((m) => m.thread_id === t.id).sort(byNewest("created_at")).slice(0, MESSAGES_PER_THREAD)
            .map(({ role, content, model, created_at }) => ({ role, content, model, created_at })),
        }));
    },
    // Scope staging requires the dedicated database RPC; tests that exercise it inject a synthetic implementation.
    saveBuildScope: async (_args) => { throw new StoreError("Visual scope storage unavailable"); },
    // Tests: reach a stored thread directly (e.g. to break its flag).
    _thread: (id) => threads.find((t) => t.id === id),
    listMessages: async (threadId) => messages.filter((m) => m.thread_id === threadId),
    addMessage: async (threadId, msg) => {
      const m = {
        id: randomUUID(), thread_id: threadId, model: null, input_tokens: 0, output_tokens: 0, cost_usd: 0,
        ...msg, created_at: now(),
      };
      messages.push(m);
      const t = threads.find((x) => x.id === threadId);
      if (t) t.updated_at = m.created_at;
      return m;
    },
    listNotes: async (projectId) => notes.filter((n) => n.project_id === projectId).map((n) => ({ ...n })),
    addNote: async (projectId, content, extra = {}) => {
      const n = { id: randomUUID(), project_id: projectId, content, source: "owner", model: null, thread_id: null, pending: false, replaces: null, forget: false, ...extra, created_at: now() };
      notes.push(n);
      return { ...n };
    },
    updateNote: async (noteId, patch) => {
      const n = notes.find((x) => x.id === noteId);
      if (!n) return null;
      Object.assign(n, patch);
      return { ...n };
    },
    deleteNote: async (noteId) => {
      const i = notes.findIndex((n) => n.id === noteId);
      if (i >= 0) notes.splice(i, 1);
      // Same as the database: proposals about a deleted note go with it.
      for (let j = notes.length - 1; j >= 0; j--) if (notes[j].replaces === noteId) notes.splice(j, 1);
      return i >= 0;
    },
    spend: async (threadId, since) => ({
      monthUsd: messages.filter((m) => m.created_at >= since).reduce((n, m) => n + m.cost_usd, 0),
      threadUsd: messages.filter((m) => m.thread_id === threadId).reduce((n, m) => n + m.cost_usd, 0),
    }),
    listConnectors: async () => connectors.map((c) => structuredClone(c)),
    addConnector: async (c) => {
      const row = { id: randomUUID(), enabled: true, ...structuredClone(c), created_at: now() };
      connectors.push(row);
      return structuredClone(row);
    },
    setConnectorEnabled: async (id, enabled) => {
      const c = connectors.find((x) => x.id === id);
      if (c) c.enabled = enabled;
      return c ? structuredClone(c) : null;
    },
    deleteConnector: async (id) => {
      const i = connectors.findIndex((c) => c.id === id);
      if (i >= 0) connectors.splice(i, 1);
      return i >= 0;
    },
    getControl: async () => {
      if (ctl === "unreadable") throw new StoreError("Workspace storage returned 404");
      return { stopped: ctl, updated_at: now() };
    },
    setControl: async (stopped) => { ctl = stopped; return { stopped, updated_at: now() }; },
    addFile: async (f) => {
      const row = { id: randomUUID(), ...f, created_at: now() };
      files.push(row);
      const { data, ...info } = row;
      return info;
    },
    countFiles: async (threadId) => files.filter((f) => f.thread_id === threadId).length,
    fileInfo: async (threadId, ids) => files.filter((f) => f.thread_id === threadId && ids.includes(f.id)).map(({ data, ...info }) => info),
    getFiles: async (threadId, ids) => files.filter((f) => f.thread_id === threadId && ids.includes(f.id)).map((f) => ({ ...f })),
    listAgents: async (projectId) => agents.filter((a) => a.project_id === projectId).map((a) => ({ ...a })),
    listEnabledAgents: async () => agents.filter((a) => a.enabled === true).map((a) => ({ ...a })),
    countAgents: async () => agents.length,
    getAgent: async (id) => { const a = agents.find((x) => x.id === id); return a ? { ...a } : null; },
    addAgent: async (a) => {
      const row = { id: randomUUID(), enabled: true, thread_id: null, thread_month: null, last_run_at: null, last_status: null, ...a, created_at: now() };
      agents.push(row);
      return { ...row };
    },
    updateAgent: async (id, patch) => { const a = agents.find((x) => x.id === id); if (a) Object.assign(a, patch); return a ? { ...a } : null; },
    deleteAgent: async (id) => { const i = agents.findIndex((a) => a.id === id); if (i >= 0) agents.splice(i, 1); return i >= 0; },
    getAgentCheckpoint: async (id) => {
      const a = agents.find((x) => x.id === id);
      return a?.checkpoint ? { text: a.checkpoint, at: a.checkpoint_at ?? null } : null;
    },
    listAgentCheckpoints: async (projectId) => agents.filter((a) => a.project_id === projectId)
      .map((a) => ({ id: a.id, checkpoint: a.checkpoint ?? null, checkpoint_at: a.checkpoint_at ?? null })),
    setAgentCheckpoint: async (id, text, at) => {
      const a = agents.find((x) => x.id === id);
      if (a) Object.assign(a, { checkpoint: text, checkpoint_at: text ? at : null });
      return Boolean(a);
    },
    claimAgentRun: async (id, before, at) => {
      const a = agents.find((x) => x.id === id && x.enabled === true && (!x.last_run_at || x.last_run_at < before));
      if (!a) return null;
      Object.assign(a, { last_run_at: at, last_status: "Running…" });
      return { ...a };
    },
    listActions: async (threadId) => actions.filter((a) => a.thread_id === threadId).sort(byNewest("created_at")).map((a) => structuredClone(a)),
    getAction: async (id) => structuredClone(actions.find((a) => a.id === id) ?? null),
    addAction: async (a) => {
      const row = { id: randomUUID(), result: null, result_url: null, decided_at: null, ...structuredClone(a), created_at: now() };
      actions.push(row);
      return structuredClone(row);
    },
    moveAction: async (id, from, patch) => {
      const a = actions.find((x) => x.id === id && x.status === from);
      if (!a) return null;
      Object.assign(a, structuredClone(patch));
      return structuredClone(a);
    },
    // Tests: reach a stored action directly (e.g. to tamper with it).
    _action: (id) => actions.find((a) => a.id === id),
    // Tests: flip the switch from "another tab" while a request is running.
    _setControl: (v) => { ctl = v; },
  };
}
