// Workspace storage (Phase 1): projects, threads and messages.
// Production uses the Command Post's own Supabase project over its REST API; tests use the memory store.
import { randomUUID } from "node:crypto";

export const MODELS = Object.freeze(["claude", "chatgpt", "gemini", "perplexity"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (v) => typeof v === "string" && UUID.test(v);

const PROJECT_COLS = "id,name,created_at";
const THREAD_COLS = "id,project_id,title,model,created_at,updated_at";
const NOTE_COLS = "id,project_id,content,created_at";
const MESSAGE_COLS = "id,thread_id,role,content,model,input_tokens,output_tokens,cost_usd,created_at";

export class StoreError extends Error {}

// Both settings are needed, and the URL must be https so the service key never travels in the clear.
export function workspaceConfigured(env) {
  if (!env.ACP_WORKSPACE_DB_URL || !env.ACP_WORKSPACE_DB_KEY) return false;
  try { return new URL(env.ACP_WORKSPACE_DB_URL).protocol === "https:"; } catch { return false; }
}

export function createSupabaseStore(env, f = fetch) {
  const base = new URL("/rest/v1/", env.ACP_WORKSPACE_DB_URL).href;
  const key = String(env.ACP_WORKSPACE_DB_KEY).trim();
  async function call(method, path, body) {
    const res = await f(base + path, {
      method,
      headers: {
        apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json",
        ...(method === "POST" || method === "DELETE" ? { prefer: "return=representation" } : {}),
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
    listThreads: (projectId) =>
      call("GET", `ws_threads?select=${THREAD_COLS}&project_id=eq.${projectId}&order=updated_at.desc&limit=200`),
    getThread: async (id) => (await call("GET", `ws_threads?select=${THREAD_COLS}&id=eq.${id}`))[0] ?? null,
    createThread: async (projectId, title, model) =>
      one(await call("POST", `ws_threads?select=${THREAD_COLS}`, { project_id: projectId, title, model })),
    listMessages: (threadId) =>
      call("GET", `ws_messages?select=${MESSAGE_COLS}&thread_id=eq.${threadId}&order=created_at.asc&limit=500`),
    addMessage: async (threadId, msg) =>
      one(await call("POST", `ws_messages?select=${MESSAGE_COLS}`, { thread_id: threadId, ...msg })),
    listNotes: (projectId) =>
      call("GET", `ws_notes?select=${NOTE_COLS}&project_id=eq.${projectId}&order=created_at.asc&limit=50`),
    addNote: async (projectId, content) =>
      one(await call("POST", `ws_notes?select=${NOTE_COLS}`, { project_id: projectId, content })),
    deleteNote: async (noteId) => (await call("DELETE", `ws_notes?id=eq.${noteId}&select=id`)).length > 0,
    spend: async (threadId, since) => {
      const row = one(await call("POST", "rpc/ws_spend", { p_thread: threadId, p_since: since }));
      return { monthUsd: Number(row.month_usd) || 0, threadUsd: Number(row.thread_usd) || 0 };
    },
  };
}

// In-memory store with the same behaviour, for tests and local runs.
export function createMemoryStore() {
  const projects = [], threads = [], messages = [], notes = [];
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
      const t = { id: randomUUID(), project_id: projectId, title, model, created_at: at, updated_at: at };
      threads.push(t);
      return t;
    },
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
    listNotes: async (projectId) => notes.filter((n) => n.project_id === projectId),
    addNote: async (projectId, content) => {
      const n = { id: randomUUID(), project_id: projectId, content, created_at: now() };
      notes.push(n);
      return n;
    },
    deleteNote: async (noteId) => {
      const i = notes.findIndex((n) => n.id === noteId);
      if (i >= 0) notes.splice(i, 1);
      return i >= 0;
    },
    spend: async (threadId, since) => ({
      monthUsd: messages.filter((m) => m.created_at >= since).reduce((n, m) => n + m.cost_usd, 0),
      threadUsd: messages.filter((m) => m.thread_id === threadId).reduce((n, m) => n + m.cost_usd, 0),
    }),
  };
}
