// Workspace API (Phase 1): projects, threads and messages behind the site password.
// Clients can only post their own "user" messages; AI replies are written here, by the chat action, after the
// budget checks.
import { hasSitePassword, isSameOrigin } from "./_lib/site-auth.js";
import { MODELS, StoreError, createSupabaseStore, isId, workspaceConfigured } from "./_lib/workspace-store.js";
import { BudgetStop, ModelError, estimateUsd, isPaid, mergeTurns, modelStatus, runChat, trimHistory } from "./_lib/workspace-models.js";
import { pluginStatus, readyTools, runTool, urlsIn } from "./_lib/workspace-plugins.js";
import { mcpServers, mcpStatus, mcpTools } from "./_lib/workspace-mcp.js";
import {
  MAX_CONNECTORS, checkHttpTool, checkMcpConnector, connectorTools, describeRow, fingerprint, guardedFetch, inspectMcp,
  summary, tokenReuseProblem,
} from "./_lib/workspace-connectors.js";
import { STOP_MARK, harmCheck, logRefusal, refusalText, textOf } from "./_lib/workspace-rules.js";
import { CRITIQUE_MARK, SYNTHESIS_MARK, critiquePrompt, estimateRounds, roundtableState, synthesisPrompt } from "./_lib/workspace-roundtable.js";

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
// The "Stop everything" switch. Returns why AI work may not run, or null. It fails closed: if the switch can't be
// read (storage down, table missing, anything odd), the answer is "stopped".
const STOPPED = "Everything is stopped: the owner pressed Stop everything. Nothing AI-related runs until it is turned back on.";
const UNREADABLE = "Everything is stopped: the Stop everything switch can't be read right now, so nothing AI-related runs (fail-safe).";
async function stopReason(store) {
  try {
    const c = await store.getControl();
    return c && c.stopped === false ? null : c ? STOPPED : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}
const stopped = (why) => error(423, why);

// Rules gate: a refused request, tool call or reply is logged and written into the thread, so the owner sees what
// was refused and why. `r` carries the cost when a model call already happened (a withheld reply still cost money).
async function refuse(store, threadId, where, rule, model = null, r = null, suffix = "") {
  logRefusal(where, rule);
  return store.addMessage(threadId, {
    role: "assistant", content: (refusalText(where, rule) + suffix).slice(0, 32_000), model,
    ...(r ? { input_tokens: r.inputTokens, output_tokens: r.outputTokens, cost_usd: Math.round(r.costUsd * 1e6) / 1e6 } : {}),
  });
}
// A model's reply, saved — unless the rules gate refuses it, in which case the refusal is saved instead (with the
// cost, which was spent either way). `suffix` (the web audit) is kept either way.
async function gatedReply(store, threadId, model, text, r, prefix = "", suffix = "") {
  const rule = harmCheck(text);
  if (rule) return refuse(store, threadId, "reply", rule, model, r, suffix);
  return reply(store, threadId, model, `${prefix}${text}`.slice(0, 32_000 - suffix.length) + suffix, r);
}
// Tools as the model sees them, wrapped so every call first passes the stop switch and the rules gate.
function gatedRunTool(store, threadId, run) {
  return async (name, args, soFar) => {
    const why = await stopReason(store);
    if (why) return { ok: false, text: "Stopped by the owner. Do not call any more tools; answer with what you have." };
    const rule = harmCheck(textOf(args).join("\n"));
    if (rule) {
      await refuse(store, threadId, String(name).slice(0, 80), rule);
      return { ok: false, text: `Refused by the workspace's rules: ${rule.reason}. Do not try this again.` };
    }
    return run(name, args, soFar);
  };
}
const refusedRequest = (rule, message) => ({
  status: 422, body: { error: `Refused by the rules gate: ${rule.reason}. Nothing was sent to any AI. The reason is saved in the thread.`, refused: message },
});

// The audit list of web calls made during one reply, written under it in the thread.
function webAuditText(log) {
  if (!log.length) return "";
  const total = log.reduce((n, e) => n + e.usd, 0);
  return `\n\nWeb activity (audit, times UTC, total $${total.toFixed(3)}):\n` +
    log.map((e) => `- ${e.at.slice(11, 19)} ${e.kind}: ${e.target}${e.usd ? ` ($${e.usd.toFixed(3)})` : ""}`).join("\n");
}

const reply = (store, threadId, model, text, r) => store.addMessage(threadId, {
  role: "assistant", content: text, model,
  input_tokens: r.inputTokens, output_tokens: r.outputTokens, cost_usd: Math.round(r.costUsd * 1e6) / 1e6,
});


// Saved connectors. A missing table (setup step not done yet) or a storage error means none: chat carries on
// without them, and the Tools page says the setup step is needed.
async function savedConnectors(store) {
  try { return { rows: await store.listConnectors(), ready: true }; } catch { return { rows: [], ready: false }; }
}
// Checks a connector or custom tool from the Tools page. Returns an error response, or { spec, fp, summary }.
async function checkConnector(store, args, env, deps) {
  const kind = args.kind;
  if (kind !== "http" && kind !== "mcp") return error(400, "Pick a connector or a custom tool.");
  const raw = args.spec && typeof args.spec === "object" && !Array.isArray(args.spec) ? args.spec : null;
  if (!raw) return error(400, "Nothing to check.");
  let project = null;
  if (raw.projectId != null) {
    if (!isId(raw.projectId) || !(project = await store.getProject(raw.projectId))) return error(400, "Unknown project.");
  }
  const { rows, ready } = await savedConnectors(store);
  if (!ready) return error(503, "Connector storage isn't set up yet: the one-time setup step (the ws_connectors table) is still to do.");
  const taken = new Set([...rows.map((r) => r.name), ...mcpServers(env).map((s) => s.name)]);
  let checked;
  if (kind === "http") checked = checkHttpTool(raw, env, taken);
  else {
    const halt = await stopReason(store);
    if (halt) return stopped(halt);
    const seen = await inspectMcp(env, raw, deps.net);
    if (seen.problems.length) return { status: 422, body: { error: "Not saved. See the reasons below.", problems: seen.problems } };
    checked = checkMcpConnector(raw, env, seen.tools, taken);
  }
  const { spec, problems } = checked;
  if (!problems.length) {
    const reuse = tokenReuseProblem(spec, rows, env);
    if (reuse) problems.push(reuse);
  }
  if (problems.length) return { status: 422, body: { error: "Not saved. See the reasons below.", problems } };
  return { spec, fp: fingerprint(spec), summary: summary(spec, { projectName: project?.name, caps: caps(env) }), count: rows.length };
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
  // Tools page: every connector and custom tool, what each can reach, and whether it is on.
  async tools_overview(store, args, env) {
    const { rows, ready } = await savedConnectors(store);
    const projects = await store.listProjects();
    const name = (id) => projects.find((p) => p.id === id)?.name ?? null;
    return {
      setupNeeded: !ready, caps: caps(env),
      connectors: rows.map((r) => ({ ...describeRow(r), summary: summary(r.spec, { projectName: name(r.project_id), caps: caps(env) }) })),
      // Servers set in Vercel (ACP_MCP_SERVERS) are shown but can only be changed there.
      fromVercel: mcpServers(env).map((s) => ({ name: s.name, host: new URL(s.url).host, tools: s.tools.map((t) => t.name), keyVar: s.tokenVar })),
      projects: projects.map((p) => ({ id: p.id, name: p.name })),
    };
  },
  // Asks an MCP server which tools it offers, so the owner can pick. Nothing is saved.
  async connector_inspect(store, args, env, deps) {
    const halt = await stopReason(store);
    if (halt) return stopped(halt);
    const out = await inspectMcp(env, args, deps.net);
    return out.problems.length ? { status: 422, body: { error: "Couldn't check that server.", problems: out.problems } } : { tools: out.tools };
  },
  // Checks a definition and returns the plain-language summary and the confirmation code. Nothing is saved.
  async connector_preview(store, args, env, deps) {
    const c = await checkConnector(store, args, env, deps);
    if (c.status) return c;
    return { spec: c.spec, summary: c.summary, confirm: c.fp };
  },
  // Saves it, only when `confirm` matches what the owner was shown (any change needs a new preview).
  async connector_save(store, args, env, deps) {
    const c = await checkConnector(store, args, env, deps);
    if (c.status) return c;
    if (args.confirm !== c.fp) return error(409, "This changed since you reviewed it. Review it again and confirm.");
    if (c.count >= MAX_CONNECTORS) return error(409, `Up to ${MAX_CONNECTORS} connectors and tools. Delete one first.`);
    const row = await store.addConnector({ project_id: c.spec.projectId, kind: c.spec.kind, name: c.spec.name, spec: c.spec, fingerprint: c.fp, enabled: true });
    console.warn(JSON.stringify({ event: "connector_added", kind: row.kind, name: row.name, host: new URL(row.spec.url).host }));
    return { connector: describeRow(row) };
  },
  // On/off, instantly: a switched-off connector is left out of the very next reply.
  async connector_set_enabled(store, args) {
    if (!isId(args.id) || typeof args.enabled !== "boolean") return error(400, "Say which connector, and on or off.");
    const row = await store.setConnectorEnabled(args.id, args.enabled);
    return row ? { connector: describeRow(row) } : error(404, "Unknown connector.");
  },
  async connector_delete(store, args) {
    if (!isId(args.id)) return error(400, "Unknown connector.");
    return (await store.deleteConnector(args.id)) ? { deleted: true } : error(404, "Unknown connector.");
  },
  // The "Stop everything" switch. Reading it never fails: an unreadable switch reports stopped.
  async control(store) {
    const why = await stopReason(store);
    return { stopped: Boolean(why), reason: why };
  },
  // Only the owner, behind the site password, can flip it. No AI has a tool for this.
  async set_control(store, args) {
    if (typeof args.stopped !== "boolean") return error(400, "Say stopped: true or false.");
    await store.setControl(args.stopped);
    console.warn(JSON.stringify({ event: args.stopped ? "stop_everything" : "resume_everything" }));
    const why = await stopReason(store);
    return { stopped: Boolean(why), reason: why };
  },
  // Which models can answer, and the budget so far.
  async models(store, args, env, deps) {
    const threadId = isId(args.threadId) ? args.threadId : null;
    const spent = await store.spend(threadId, monthStart(deps.now()));
    const models = Object.fromEntries(MODELS.map((m) => {
      const s = modelStatus(env, m);
      return [m, { ready: s.ready, reason: s.reason, via: s.via ?? null }];
    }));
    const why = await stopReason(store);
    const own = Object.fromEntries((await savedConnectors(store)).rows.map((r) => [`conn_${r.name}`, {
      title: r.kind === "http" ? `Tool: ${r.name}` : `Connector: ${r.name}`, description: describeRow(r).host, ready: r.enabled,
    }]));
    return {
      models, plugins: { ...pluginStatus(env), ...mcpStatus(env), ...own },
      control: { stopped: Boolean(why), reason: why },
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
    const halt = await stopReason(store);
    if (halt) return stopped(halt);
    const model = thread.model;
    const status = modelStatus(env, model);
    if (!status.ready) return error(409, `This thread's AI isn't available: ${status.reason}`);

    const stored = await store.listMessages(thread.id);
    const history = mergeTurns(stored);
    if (content) history.push({ role: "user", content });
    else if (stored.at(-1)?.role !== "user") return error(400, "There is no message waiting for a reply.");
    // Rules gate on the owner's message (a retry re-checks the saved one). A refused message is not saved, so it
    // never reaches any AI later as history either.
    const asked = content ?? stored.at(-1).content;
    const rule = harmCheck(asked);
    if (rule) return refusedRequest(rule, await refuse(store, thread.id, "request", rule));
    const sent = trimHistory(mergeTurns(history));

    const over = await budgetCheck(store, env, deps, thread.id, isPaid(env, model));
    const first = over(estimateUsd(model, sent, env));
    if (first) return error(402, first);

    const saved = content ? await store.addMessage(thread.id, { role: "user", content }) : null;
    // MCP servers are asked for their tools only for models that can use tools.
    // Connectors and custom tools from the Tools page: switched on, confirmed, and for this project (or all).
    const tools = [...readyTools(env), ...(model === "perplexity" ? [] : [
      ...await mcpTools(env, deps.fetch),
      ...await connectorTools(env, (await savedConnectors(store)).rows, thread.project_id, deps.net).catch(() => []),
    ])];
    // Web access for this reply: pages the owner linked may be read; search results add more. Each web call is
    // checked against the caps first (web calls are always paid) and listed under the reply.
    const allowedUrls = new Set(urlsIn(asked));
    const overWeb = await budgetCheck(store, env, deps, thread.id, true);
    const webLog = [];
    const webCtx = (soFar) => ({
      allowedUrls, charge: async (usd) => overWeb(soFar + usd),
      audit: (kind, target, usd) => webLog.push({ at: deps.now().toISOString(), kind, target: String(target).slice(0, 300), usd }),
    });
    const record = (text, r) => reply(store, thread.id, model, (text + webAuditText(webLog)).slice(0, 32_000), r);
    let out;
    try {
      out = await runChat(env, model, sent, {
        f: deps.fetch, tools,
        notes: (await store.listNotes(thread.project_id)).map((n) => n.content),
        runTool: gatedRunTool(store, thread.id, (name, a, soFar = 0) => runTool(env, tools, name, a, deps.fetch, webCtx(soFar))),
        // Every later round of tool use is checked again: the stop switch, and the caps counting what this reply
        // has already cost (web calls included).
        beforeCall: async (est, soFar) => {
          if (soFar > 0 && await stopReason(store)) throw new BudgetStop(`${STOP_MARK} The reply was cut short; no further steps ran.`);
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
    const message = await gatedReply(store, thread.id, model, out.text, out, "", webAuditText(webLog));
    return { saved, message };
  },
  // Side-by-side answers: one message goes to 2-3 AIs at once and each answer is saved with its AI. Plugins stay
  // off here, so the budget check before the calls covers everything they can spend.
  async compare(store, args, env, deps) {
    const p = await askSeveral(store, args, env);
    if (p.status) return p;
    const why = (await budgetCheck(store, env, deps, p.thread.id, p.paid.length > 0))(p.paid.reduce((n, m) => n + estimateUsd(m, p.sent, env), 0));
    if (why) return error(402, why);
    return runRound1(store, env, deps, p);
  },
  // Roundtable mode, before it starts: the worst-case cost of all three rounds and whether the caps allow it.
  async roundtable_estimate(store, args, env, deps) {
    const p = await askSeveral(store, { ...args, content: typeof args.content === "string" && args.content.trim() ? args.content : "?" }, env);
    if (p.status) return p;
    const { estimate, why } = await planCheck(store, env, deps, p);
    const spent = await store.spend(p.thread.id, monthStart(deps.now()));
    return { estimate, lead: p.lead, fits: !why, why, budget: { ...caps(env), monthSpent: spent.monthUsd, threadSpent: spent.threadUsd } };
  },
  // Roundtable mode, one round per request so each stays inside the time limit and is budget-checked on its own.
  // step "start": round 1, every AI answers on its own (side-by-side), refused unless all 3 rounds fit the caps.
  // step "critique": round 2, each AI that answered reads the others' answers (labelled A, B…), critiques them and
  // revises its own. step "synthesize": round 3, the lead AI writes one conclusion for the owner.
  async roundtable(store, args, env, deps) {
    if (args.step === "start") {
      const p = await askSeveral(store, args, env);
      if (p.status) return p;
      const { estimate, why } = await planCheck(store, env, deps, p);
      if (why) return error(402, `A full roundtable could cost up to ${usd(estimate.total)}. ${why}`);
      const out = await runRound1(store, env, deps, p);
      if ("status" in out) return out;
      return { ...out, estimate, lead: p.lead, roundtableUsd: sumCost(out.messages) };
    }
    if (args.step !== "critique" && args.step !== "synthesize") return error(400, "Unknown roundtable step.");
    if (!isId(args.threadId)) return error(400, "Unknown thread.");
    const thread = await store.getThread(args.threadId);
    if (!thread) return error(404, "Unknown thread.");
    const halt = await stopReason(store);
    if (halt) return stopped(halt);
    const state = roundtableState(await store.listMessages(thread.id));
    if (!state || !state.answers.length) return error(409, "There is no side-by-side answer to discuss yet.");
    if (state.synthesis) return error(409, "This roundtable is already finished. Ask a new question to start another.");
    const over = await budgetCheck(store, env, deps, thread.id, true);
    const notes = (await store.listNotes(thread.project_id)).map((n) => n.content);
    const ask = (m, prompt) => runChat(env, m, [{ role: "user", content: prompt }], { f: deps.fetch, notes });
    const failedReply = (m, e) => (e.usage?.costUsd > 0
      ? reply(store, thread.id, m, `(The AI provider failed partway through this reply: ${e.message})`, e.usage) : null);
    const ready = (m) => modelStatus(env, m).ready;

    if (args.step === "critique") {
      if (state.answers.length < 2) return error(409, "A roundtable needs answers from at least 2 AIs; only 1 answered.");
      const done = new Set(state.critiques.map((c) => c.model));
      const todo = state.answers.filter((a) => !done.has(a.model) && ready(a.model));
      if (!todo.length) return error(409, "Round 2 has already run.");
      const prompts = todo.map((a) => ({
        m: a.model,
        prompt: critiquePrompt(state.question.content, a.content, state.answers.filter((o) => o !== a).map((o) => o.content)),
      }));
      const why = over(prompts.filter(({ m }) => isPaid(env, m)).reduce((n, { m, prompt }) => n + estimateUsd(m, [{ content: prompt }], env), 0));
      if (why) return error(402, why);
      const results = await Promise.all(prompts.map(({ m, prompt }) => ask(m, prompt)
        .then((r) => ({ m, r }), (e) => { if (e instanceof ModelError) return { m, e }; throw e; })));
      const messages = [], failed = [];
      for (const { m, r, e } of results) {
        if (r) { messages.push(await gatedReply(store, thread.id, m, r.text, r, `${CRITIQUE_MARK}\n`)); continue; }
        await failedReply(m, e);
        failed.push({ model: m, error: e.message });
      }
      const after = roundtableState(await store.listMessages(thread.id));
      return { messages, failed, roundtableUsd: sumCost([...after.answers, ...after.critiques]) };
    }

    // Round 3. The lead is the thread's own AI when it answered; if the lead fails, the next AI that answered takes
    // over, so one failure doesn't lose the conclusion.
    const answered = state.answers.map((a) => a.model);
    const order = [...new Set([thread.model, ...state.critiques.map((c) => c.model), ...answered])]
      .filter((m) => answered.includes(m) && ready(m));
    if (!order.length) return error(409, "None of the AIs that answered can write the conclusion right now.");
    const prompt = synthesisPrompt(state.question.content, state.answers, state.critiques);
    const failed = [];
    let failedUsd = 0;
    for (const m of order) {
      const halted = await stopReason(store);
      if (halted) return { status: 423, body: { error: halted, failed } };
      const why = over(failedUsd + (isPaid(env, m) ? estimateUsd(m, [{ content: prompt }], env) : 0));
      if (why) return { status: 402, body: { error: why, failed } };
      let r;
      try { r = await ask(m, prompt); } catch (e) {
        if (!(e instanceof ModelError)) throw e;
        await failedReply(m, e);
        failedUsd += e.usage?.costUsd ?? 0;
        failed.push({ model: m, error: e.message });
        continue;
      }
      const footer = whoTookPart(args.models, state, m, failed);
      const message = await gatedReply(store, thread.id, m, `${r.text}\n\n${footer}`, r, `${SYNTHESIS_MARK}\n`);
      return { message, failed, lead: m, roundtableUsd: sumCost([...state.answers, ...state.critiques, message]) };
    }
    return { status: 502, body: { error: "No AI could write the conclusion. The first answers and critiques are saved.", failed } };
  },
});

const sumCost = (ms) => Math.round(ms.reduce((n, m) => n + Number(m.cost_usd || 0), 0) * 1e6) / 1e6;

// Who took part, and who dropped out at which round, written under the conclusion.
function whoTookPart(selected, state, lead, leadFailed) {
  const name = (m) => NAMES[m] ?? m;
  const answered = state.answers.map((a) => a.model);
  const critiqued = new Set(state.critiques.map((c) => c.model));
  const picked = Array.isArray(selected) ? [...new Set(selected)].filter((m) => MODELS.includes(m)) : answered;
  const out = [];
  for (const m of picked) if (!answered.includes(m)) out.push(`${name(m)} (didn't answer round 1)`);
  if (answered.length > 1) for (const m of answered) if (!critiqued.has(m)) out.push(`${name(m)} (missed round 2)`);
  for (const f of leadFailed) out.push(`${name(f.model)} (couldn't write the conclusion)`);
  return `Roundtable: ${answered.map(name).join(", ")}. Conclusion by ${name(lead)}.` +
    (out.length ? ` Dropped out: ${out.join("; ")}.` : "");
}

// Checks shared by side-by-side answers and a roundtable's first round. Returns an error response, or the plan.
async function askSeveral(store, args, env) {
  if (!isId(args.threadId)) return error(400, "Unknown thread.");
  const { content, error: bad } = userMessage(args);
  if (bad) return error(400, bad);
  const models = Array.isArray(args.models) ? [...new Set(args.models)] : [];
  if (models.length < 2 || models.length > MAX_COMPARE || !models.every((m) => MODELS.includes(m))) {
    return error(400, `Pick 2 to ${MAX_COMPARE} AIs to compare.`);
  }
  const thread = await store.getThread(args.threadId);
  if (!thread) return error(404, "Unknown thread.");
  const halt = await stopReason(store);
  if (halt) return stopped(halt);
  for (const m of models) {
    const status = modelStatus(env, m);
    if (!status.ready) return error(409, `${NAMES[m]} isn't available: ${status.reason}`);
  }
  const before = mergeTurns(await store.listMessages(thread.id));
  const history = [...before, { role: "user", content }];
  const sent = trimHistory(mergeTurns(history));
  const lead = models.includes(thread.model) ? thread.model : models[0];
  return { thread, content, models, sent, lead, paid: models.filter((m) => isPaid(env, m)) };
}

// The worst case for all three rounds of a roundtable, and why it would go over a cap (or null).
async function planCheck(store, env, deps, p) {
  const chars = p.sent.reduce((n, m) => n + m.content.length, 0);
  const estimate = estimateRounds(env, p.models, p.lead, chars - p.content.length, p.content.length, (m) => isPaid(env, m));
  const why = (await budgetCheck(store, env, deps, p.thread.id, p.paid.length > 0))(estimate.total);
  return { estimate, why };
}

async function runRound1(store, env, deps, { thread, content, models, sent }) {
  const rule = harmCheck(content);
  if (rule) return refusedRequest(rule, await refuse(store, thread.id, "request", rule));
  const saved = await store.addMessage(thread.id, { role: "user", content });
  const notes = (await store.listNotes(thread.project_id)).map((n) => n.content);
  const results = await Promise.all(models.map((m) => runChat(env, m, sent, { f: deps.fetch, notes })
    .then((r) => ({ m, r }), (e) => { if (e instanceof ModelError) return { m, e }; throw e; })));
  const messages = [], failed = [];
  for (const { m, r, e } of results) {
    if (r) { messages.push(await gatedReply(store, thread.id, m, r.text, r)); continue; }
    // Calls made before the failure still cost money, so they are recorded.
    if (e.usage?.costUsd > 0) await reply(store, thread.id, m, `(The AI provider failed partway through this reply: ${e.message})`, e.usage);
    failed.push({ model: m, error: e.message });
  }
  return { saved, messages, failed };
}

// Pure request handler, so tests can drive it with a memory store.
export async function handle(req, env, makeStore = createSupabaseStore, deps = {}) {
  // `net` is the network for connectors and custom tools: guarded (public addresses only) in production.
  const d = { fetch: deps.fetch ?? fetch, net: deps.net ?? deps.fetch ?? guardedFetch, now: deps.now ?? (() => new Date()) };
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
