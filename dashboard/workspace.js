// Workspace page (Phase 1 step 2): projects, threads and the open conversation, from /api/workspace.
// Everything is rendered with textContent and never parsed as HTML, because messages are untrusted text.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const MODEL_NAMES = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity" };
  let projectId = null, threadId = null, busy = false;

  // The password lives in memory for this tab only; it is never written to browser storage (ARN-53).
  let password = "";

  async function post(action, args, retry) {
    let r;
    try {
      r = await fetch("/api/workspace", { method: "POST", headers: { "content-type": "application/json", "x-acp-password": password }, body: JSON.stringify({ action, args: args || {} }) });
    } catch (e) { throw new Error("Network error: couldn't reach the server."); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && retry !== false) {
      const pw = window.prompt("Password for AI Command Post");
      if (pw) { password = pw; return post(action, args, false); }
    }
    if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "Something went wrong (" + r.status + ").");
    return j;
  }

  function say(text, cls) { const n = $("pageMsg"); n.hidden = !text; n.className = "msg" + (cls ? " " + cls : ""); n.textContent = text || ""; }
  const when = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };

  function renderList(node, items, emptyText, current, label, sub, pick) {
    node.replaceChildren();
    if (!items.length) { node.append(el("li", "empty", emptyText)); return; }
    for (const it of items) {
      const b = el("button");
      b.type = "button";
      b.setAttribute("aria-current", String(it.id === current));
      b.append(el("span", null, label(it)), el("span", "sub", sub(it)));
      if (it.model) b.dataset.model = it.model;
      b.addEventListener("click", () => pick(it));
      const li = el("li"); li.append(b); node.append(li);
    }
  }

  async function loadProjects() {
    const { projects } = await post("list_projects");
    renderList($("pList"), projects, "No projects yet. Click New to start one.", projectId,
      (p) => p.name, (p) => "Created " + when(p.created_at), (p) => openProject(p.id));
  }

  async function openProject(id) {
    projectId = id; threadId = null;
    $("tNew").disabled = false;
    closeThread();
    await Promise.all([loadProjects(), loadThreads()]);
  }

  async function loadThreads() {
    if (!projectId) return;
    const { threads } = await post("list_threads", { projectId });
    renderList($("tList"), threads, "No threads yet. Click New to start one.", threadId,
      (t) => t.title, (t) => (MODEL_NAMES[t.model] || t.model) + " · " + when(t.updated_at), (t) => openThread(t.id));
  }

  function closeThread() {
    $("cH").textContent = "No thread open";
    $("cModel").hidden = true;
    $("cForm").hidden = true;
    $("mList").replaceChildren();
  }

  async function openThread(id) {
    threadId = id;
    const { thread, messages } = await post("get_thread", { threadId: id });
    $("cH").textContent = thread.title;
    const chip = $("cModel"); chip.hidden = false; chip.dataset.model = thread.model;
    chip.lastElementChild.textContent = MODEL_NAMES[thread.model] || thread.model;
    const list = $("mList"); list.replaceChildren();
    if (!messages.length) list.append(el("p", "empty", "No messages yet."));
    for (const m of messages) {
      const box = el("div", "m " + (m.role === "assistant" ? "assistant" : "user"));
      if (m.model) box.dataset.model = m.model;
      box.append(el("span", "who", m.role === "assistant" ? (MODEL_NAMES[m.model] || "AI") : "You"), document.createTextNode(m.content));
      list.append(box);
    }
    list.scrollTop = list.scrollHeight;
    $("cForm").hidden = false;
    await loadThreads();
  }

  // Run one user action at a time and report failures on the page.
  const guard = (fn) => async (ev) => {
    if (ev) ev.preventDefault();
    if (busy) return;
    busy = true; say("");
    try { await fn(); } catch (e) { say(e.message, "err"); } finally { busy = false; }
  };

  function toggle(formId, inputId, show) { $(formId).hidden = !show; if (show) $(inputId).focus(); }
  $("pNew").addEventListener("click", () => toggle("pForm", "pName", true));
  $("pCancel").addEventListener("click", () => toggle("pForm", "pName", false));
  $("tNew").addEventListener("click", () => toggle("tForm", "tTitle", true));
  $("tCancel").addEventListener("click", () => toggle("tForm", "tTitle", false));

  $("pForm").addEventListener("submit", guard(async () => {
    const { project } = await post("create_project", { name: $("pName").value });
    $("pName").value = ""; toggle("pForm", "pName", false);
    await openProject(project.id);
  }));
  $("tForm").addEventListener("submit", guard(async () => {
    const { thread } = await post("create_thread", { projectId, title: $("tTitle").value, model: $("tModel").value });
    $("tTitle").value = ""; toggle("tForm", "tTitle", false);
    await openThread(thread.id);
  }));
  $("cForm").addEventListener("submit", guard(async () => {
    const text = $("cText").value;
    if (!text.trim()) return;
    $("cSend").disabled = true;
    try {
      await post("add_message", { threadId, content: text });
      $("cText").value = "";
      await openThread(threadId);
    } finally { $("cSend").disabled = false; }
  }));
  $("cText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("cForm").requestSubmit(); });

  guard(loadProjects)();
})();
