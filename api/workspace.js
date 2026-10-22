// Workspace API (Phase 1): projects, threads and messages behind the site password.
// Clients can only post their own "user" messages; AI replies are written here, by the chat action, after the
// budget checks.
import { hasSitePassword, isSameOrigin } from "./lib/site-auth.js";
import { MODELS, StoreError, createSupabaseStore, isId, workspaceConfigured } from "./lib/workspace-store.js";
import { BudgetStop, ModelError, estimateUsd, isPaid, mergeTurns, modelStatus, runChat, trimHistory } from "./lib/workspace-models.js";
import { pluginStatus, readyTools, runTool } from "./lib/workspace-plugins.js";
import { mcpStatus, mcpTools } from "./lib/workspace-mcp.js";

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
// Text files attached to a message are folded into it, marked by name, so the 32,000-character limit covers them.
const MAX_FILES = 3;
const NOT_A_MESSAGE = "A message of 1 to 32,000 characters is required.";
function userMessage(args) {
  const files = args.attachments ?? [];
  if (!Array.isArray(files) || files.length > MAX_FILES) return { error: `Attach at most ${MAX_FILES} files.` };
  if (args.content !== undefined && typeof args.content !== "string") return { error: NOT_A_MESSAGE };
  const typed = (args.content ?? "").trim();
  const parts = typed ? [typed] : [];
  for (const f of files) {
    const name = typeof f?.name === "string" ? f.name.trim() : "";
    if (!name || name.length > 120 || /[\u0000-\u001f<>]/.test(name)) return { error: "Each file needs a plain name of up to 120 characters." };
    if (typeof f.text !== "string" || !f.text.trim() || f.text.includes("\u0000")) return { error: `${name} isn't a text file, or it's empty.` };
    parts.push(`<<<file: ${name}>>>\n${f.text.replace(/\s+$/, "")}\n<<<end of file>>>`);
  }
  const content = parts.join("\n\n");
  if (!content) return { error: NOT_A_MESSAGE };
  if (content.length > 32_000) return { error: "The message and its files are over 32,000 characters. Attach a shorter file." };
  return { content };
}
// Side-by-side answers: how many AIs one message may go to.
const MAX_COMPARE = 3;
const NAMES = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity" };

// Returns a check that says why `est` more USD would go over a cap, or null. Free calls are never stopped.
async function budgetCheck(store, env, deps, threadId, paid) {
  if (!paid) return () => null;
  const cap = caps(env);
  const spent = await store.spend(threadId, monthStart(deps.now()));
  return (est) => spent.monthUsd + est > cap.month ? `This would go over the monthly workspace budget (${usd(spent.monthUsd)} of ${usd(cap.month)} used).`
    : spent.threadUsd + est > cap.thread ? `This would go over this thread's budget (${usd(spent.threadUsd)} of ${usd(cap.thread)} used). Start a new thread to continue.`
    : null;
}
const reply = (store, threadId, model, text, r) => store.addMessage(threadId, {
  role: "assistant", content: text, model,
  input_tokens: r.inputTokens, output_tokens: r.outputTokens, cost_usd: Math.round(r.costUsd * 1e6) / 1e6,
});

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
    const { content, error: bad } = userMessage(args);
    if (bad) return error(400, bad);
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
      return [m, { ready: s.ready, reason: s.reason, via: s.via ?? null }];
    }));
    return {
      models, plugins: { ...pluginStatus(env), ...mcpStatus(env) },
      budget: { ...caps(env), monthSpent: spent.monthUsd, threadSpent: threadId ? spent.threadUsd : null },
    };
  },
  // Sends the user's message (or, with no content, retries the reply to the last one) to the thread's model.
  async chat(store, args, env, deps) {
    if (!isId(args.threadId)) return error(400, "Unknown thread.");
    const retry = args.content === undefined && args.attachments === undefined;
    const { content = null, error: bad } = retry ? {} : userMessage(args);
    if (bad) return error(400, bad);
    const thread = await store.getThread(args.threadId);
    if (!thread) return error(404, "Unknown thread.");
    const model = thread.model;
    const status = modelStatus(env, model);
    if (!status.ready) return error(409, `This thread's AI isn't available: ${status.reason}`);

    const stored = await store.listMessages(thread.id);
    const history = mergeTurns(stored);
    if (content) history.push({ role: "user", content });
    else if (stored.at(-1)?.role !== "user") return error(400, "There is no message waiting for a reply.");
    const sent = trimHistory(mergeTurns(history));

    const over = await budgetCheck(store, env, deps, thread.id, isPaid(env, model));
    const first = over(estimateUsd(model, sent, env));
    if (first) return error(402, first);

    const saved = content ? await store.addMessage(thread.id, { role: "user", content }) : null;
    // MCP servers are asked for their tools only for models that can use tools.
    const tools = [...readyTools(env), ...(model === "perplexity" ? [] : await mcpTools(env, deps.fetch))];
    const record = (text, r) => reply(store, thread.id, model, text, r);
    let out;
    try {
      out = await runChat(env, model, sent, {
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
    const message = await record(out.text, out);
    return { saved, message };
  },
  // Side-by-side answers: one message goes to 2-3 AIs at once and each answer is saved with its AI. Plugins stay
  // off here, so the budget check before the calls covers everything they can spend.
  async compare(store, args, env, deps) {
    if (!isId(args.threadId)) return error(400, "Unknown thread.");
    const { content, error: bad } = userMessage(args);
    if (bad) return error(400, bad);
    const models = Array.isArray(args.models) ? [...new Set(args.models)] : [];
    if (models.length < 2 || models.length > MAX_COMPARE || !models.every((m) => MODELS.includes(m))) {
      return error(400, `Pick 2 to ${MAX_COMPARE} AIs to compare.`);
    }
    const thread = await store.getThread(args.threadId);
    if (!thread) return error(404, "Unknown thread.");
    for (const m of models) {
      const status = modelStatus(env, m);
      if (!status.ready) return error(409, `${NAMES[m]} isn't available: ${status.reason}`);
    }
    const history = mergeTurns(await store.listMessages(thread.id));
    history.push({ role: "user", content });
    const sent = trimHistory(mergeTurns(history));

    const paid = models.filter((m) => isPaid(env, m));
    const over = await budgetCheck(store, env, deps, thread.id, paid.length > 0);
    const why = over(paid.reduce((n, m) => n + estimateUsd(m, sent, env), 0));
    if (why) return error(402, why);

    const saved = await store.addMessage(thread.id, { role: "user", content });
    const notes = (await store.listNotes(thread.project_id)).map((n) => n.content);
    const results = await Promise.all(models.map((m) => runChat(env, m, sent, { f: deps.fetch, notes })
      .then((r) => ({ m, r }), (e) => { if (e instanceof ModelError) return { m, e }; throw e; })));
    const messages = [], failed = [];
    for (const { m, r, e } of results) {
      if (r) { messages.push(await reply(store, thread.id, m, r.text, r)); continue; }
      // Calls made before the failure still cost money, so they are recorded.
      if (e.usage?.costUsd > 0) await reply(store, thread.id, m, `(The AI provider failed partway through this reply: ${e.message})`, e.usage);
      failed.push({ model: m, error: e.message });
    }
    return { saved, messages, failed };
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
