// Workspace API (Phase 1): projects, threads and messages behind the site password.
// Clients can only post their own "user" messages; AI replies are written here, by the chat action, after the
// budget checks.
import { hasSitePassword, isSameOrigin } from "./lib/site-auth.js";
import { MODELS, StoreError, createSupabaseStore, isId, workspaceConfigured } from "./lib/workspace-store.js";
import { BudgetStop, ModelError, RATES, estimateUsd, modelStatus, runChat, trimHistory } from "./lib/workspace-models.js";
import { pluginStatus, readyTools, runTool } from "./lib/workspace-plugins.js";

// Vercel: model replies can take a while.
export const config = { maxDuration: 120 };

const MAX_BODY = 65_536;
const error = (status, message) => ({ status, body: { error: message } });

function text(v, max) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= max ? t : null;
}

// Caps in USD. Unset or invalid means 0 for the month (nothing paid runs) and $1 per thread.
function caps(env) {
  const num = (v, d) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d; };
  return { month: num(env.ACP_WORKSPACE_MONTHLY_BUDGET_USD, 0), thread: num(env.ACP_WORKSPACE_THREAD_BUDGET_USD, 1) };
}
const monthStart = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
const usd = (n) => "$" + n.toFixed(2);
const MAX_NOTES = 20;

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
  async list_notes(store, args) {
    if (!isId(args.projectId)) return error(400, "Unknown project.");
    if (!(await store.getProject(args.projectId))) return error(404, "Unknown project.");
    return { notes: await store.listNotes(args.projectId) };
  },
  async add_note(store, args) {
    if (!isId(args.projectId)) return error(400, "Unknown project.");
    const content = text(args.content, 2_000);
    if (!content) return error(400, "A note of 1 to 2,000 characters is required.");
    if (!(await store.getProject(args.projectId))) return error(404, "Unknown project.");
    if ((await store.listNotes(args.projectId)).length >= MAX_NOTES) return error(409, `A project can hold ${MAX_NOTES} notes. Delete one first.`);
    return { note: await store.addNote(args.projectId, content) };
  },
  async delete_note(store, args) {
    if (!isId(args.noteId)) return error(400, "Unknown note.");
    return (await store.deleteNote(args.noteId)) ? { deleted: true } : error(404, "Unknown note.");
  },
  // Which models can answer, and the budget so far.
  async models(store, args, env, deps) {
    const threadId = isId(args.threadId) ? args.threadId : null;
    const spent = await store.spend(threadId, monthStart(deps.now()));
    const models = Object.fromEntries(MODELS.map((m) => {
      const s = modelStatus(env, m);
      return [m, { ready: s.ready, reason: s.reason }];
    }));
    return {
      models, plugins: pluginStatus(env),
      budget: { ...caps(env), monthSpent: spent.monthUsd, threadSpent: threadId ? spent.threadUsd : null },
    };
  },
  // Sends the user's message (or, with no content, retries the reply to the last one) to the thread's model.
  async chat(store, args, env, deps) {
    if (!isId(args.threadId)) return error(400, "Unknown thread.");
    const content = args.content === undefined ? null : text(args.content, 32_000);
    if (args.content !== undefined && !content) return error(400, "A message of 1 to 32,000 characters is required.");
    const thread = await store.getThread(args.threadId);
    if (!thread) return error(404, "Unknown thread.");
    const model = thread.model;
    const status = modelStatus(env, model);
    if (!status.ready) return error(409, `This thread's AI isn't available: ${status.reason}`);

    const history = (await store.listMessages(thread.id)).map((m) => ({ role: m.role, content: m.content }));
    if (content) history.push({ role: "user", content });
    else if (history.at(-1)?.role !== "user") return error(400, "There is no message waiting for a reply.");
    const sent = trimHistory(history);

    const paid = !RATES[model].freeTier;
    const cap = caps(env);
    const spent = paid ? await store.spend(thread.id, monthStart(deps.now())) : null;
    const over = (est) => !paid ? null
      : spent.monthUsd + est > cap.month ? `This would go over the monthly workspace budget (${usd(spent.monthUsd)} of ${usd(cap.month)} used).`
      : spent.threadUsd + est > cap.thread ? `This would go over this thread's budget (${usd(spent.threadUsd)} of ${usd(cap.thread)} used). Start a new thread to continue.`
      : null;
    const first = over(estimateUsd(model, sent));
    if (first) return error(402, first);

    const saved = content ? await store.addMessage(thread.id, { role: "user", content }) : null;
    const tools = readyTools(env);
    const record = (text, r) => store.addMessage(thread.id, {
      role: "assistant", content: text, model,
      input_tokens: r.inputTokens, output_tokens: r.outputTokens, cost_usd: Math.round(r.costUsd * 1e6) / 1e6,
    });
    let reply;
    try {
      reply = await runChat(env, model, sent, {
        f: deps.fetch, tools,
        notes: (await store.listNotes(thread.project_id)).map((n) => n.content),
        runTool: (name, a) => runTool(env, tools, name, a, deps.fetch),
        // Every later round of tool use is checked again, counting what this reply has already cost.
        beforeCall: async (est, soFar) => {
          const why = soFar > 0 ? over(soFar + est) : null;
          if (why) throw new BudgetStop("Stopped before finishing: " + why.charAt(0).toLowerCase() + why.slice(1));
        },
      });
    } catch (e) {
      if (!(e instanceof ModelError)) throw e;
      // Calls made before the failure still cost money, so they are recorded.
      if (e.usage?.costUsd > 0) await record(`(The AI provider failed partway through this reply: ${e.message})`, e.usage);
      return { status: 502, body: { error: `${e.message} Your message was saved; try again for a reply.`, saved } };
    }
    const message = await record(reply.text, reply);
    return { saved, message };
  },
});

// Pure request handler, so tests can drive it with a memory store.
export async function handle(req, env, makeStore = createSupabaseStore, deps = {}) {
  const d = { fetch: deps.fetch ?? fetch, now: deps.now ?? (() => new Date()) };
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
    const out = await ACTIONS[body.action](makeStore(env, d.fetch), args, env, d);
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
