// Workspace API (Phase 1): projects, threads and messages behind the site password.
// Replies from AI models are added server-side by the chat route (a later step), so clients can only
// post their own "user" messages here.
import { hasSitePassword, isSameOrigin } from "./lib/site-auth.js";
import { MODELS, StoreError, createSupabaseStore, isId, workspaceConfigured } from "./lib/workspace-store.js";

const MAX_BODY = 65_536;
const error = (status, message) => ({ status, body: { error: message } });

function text(v, max) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= max ? t : null;
}

const ACTIONS = Object.freeze({
  async list_projects(store) {
    return { projects: await store.listProjects() };
  },
  async create_project(store, args) {
    const name = text(args.name, 120);
    if (!name) return error(400, "A project name of 1 to 120 characters is required.");
    return { project: await store.createProject(name) };
  },
  async list_threads(store, args) {
    if (!isId(args.projectId)) return error(400, "Unknown project.");
    if (!(await store.getProject(args.projectId))) return error(404, "Unknown project.");
    return { threads: await store.listThreads(args.projectId) };
  },
  async create_thread(store, args) {
    if (!isId(args.projectId)) return error(400, "Unknown project.");
    const title = text(args.title, 200);
    if (!title) return error(400, "A thread title of 1 to 200 characters is required.");
    const model = args.model ?? "claude";
    if (!MODELS.includes(model)) return error(400, `Model must be one of: ${MODELS.join(", ")}.`);
    if (!(await store.getProject(args.projectId))) return error(404, "Unknown project.");
    return { thread: await store.createThread(args.projectId, title, model) };
  },
  async get_thread(store, args) {
    if (!isId(args.threadId)) return error(400, "Unknown thread.");
    const thread = await store.getThread(args.threadId);
    if (!thread) return error(404, "Unknown thread.");
    return { thread, messages: await store.listMessages(thread.id) };
  },
  async add_message(store, args) {
    if (!isId(args.threadId)) return error(400, "Unknown thread.");
    const content = text(args.content, 32_000);
    if (!content) return error(400, "A message of 1 to 32,000 characters is required.");
    if (!(await store.getThread(args.threadId))) return error(404, "Unknown thread.");
    return { message: await store.addMessage(args.threadId, { role: "user", content }) };
  },
});

// Pure request handler, so tests can drive it with a memory store.
export async function handle(req, env, makeStore = createSupabaseStore) {
  if (!env.ACP_SITE_PASSWORD) return error(503, "The website isn't configured yet.");
  if (!hasSitePassword(req, env)) return error(401, "Wrong password");
  if (req.method !== "POST") return error(405, "POST only");
  // Every action goes through POST, and some write, so all of them need a same-site browser request.
  if (!isSameOrigin(req)) return error(403, "Cross-site requests are not allowed.");
  if (!workspaceConfigured(env)) return error(503, "Workspace storage isn't set up yet.");

  let body;
  try {
    if (typeof req.body === "string" && Buffer.byteLength(req.body) > MAX_BODY) return error(413, "Request too large.");
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    if (!body || typeof body !== "object" || Array.isArray(body)) return error(400, "Invalid request.");
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY) return error(413, "Request too large.");
  } catch { return error(400, "Invalid JSON."); }

  if (typeof body.action !== "string" || !Object.hasOwn(ACTIONS, body.action)) return error(400, "Unknown action.");
  const args = body.args ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return error(400, "Invalid arguments.");

  try {
    const out = await ACTIONS[body.action](makeStore(env), args);
    return "status" in out ? out : { status: 200, body: out };
  } catch (e) {
    if (e instanceof StoreError || e?.name === "TimeoutError" || e instanceof TypeError) {
      return error(502, "Workspace storage is unavailable. Try again shortly.");
    }
    throw e;
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const out = await handle(req, process.env);
  res.status(out.status).json(out.body);
}
