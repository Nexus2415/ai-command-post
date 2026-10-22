// Workspace page (Phase 1 steps 2-3): projects, threads and the open conversation, from /api/workspace.
// Everything is rendered with textContent and never parsed as HTML, because messages are untrusted text.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const MODEL_NAMES = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity" };
  let projectId = null, threadId = null, busy = false, status = null;

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

  const money = (n) => "$" + Number(n || 0).toFixed(2);

  // Which models can answer, shown on the model picker, and the spend so far.
  async function loadStatus() {
    status = await post("models", threadId ? { threadId } : {});
    for (const opt of $("tModel").options) {
      const m = status.models[opt.value];
      opt.textContent = (MODEL_NAMES[opt.value] || opt.value) + (m && !m.ready ? " (" + m.reason.replace(/\.$/, "") + ")" : "");
    }
    const on = Object.values(status.plugins || {}).filter((x) => x.ready).map((x) => x.title);
    $("plugins").textContent = "Plugins: " + (on.length ? on.join(", ") : "none connected yet");
    const b = status.budget;
    $("budget").textContent = "This month " + money(b.monthSpent) + " of " + money(b.month) +
      (b.threadSpent == null ? "" : " · This thread " + money(b.threadSpent) + " of " + money(b.thread));
  }

  async function openProject(id) {
    projectId = id; threadId = null;
    $("tNew").disabled = false;
    $("notes").hidden = false;
    closeThread();
    await Promise.all([loadProjects(), loadThreads(), loadNotes()]);
  }

  async function loadNotes() {
    const { notes } = await post("list_notes", { projectId });
    const list = $("nList"); list.replaceChildren();
    if (!notes.length) list.append(el("li", "empty", "No notes yet."));
    for (const n of notes) {
      const row = el("li", "nrow");
      const del = el("button", null, "Delete");
      del.type = "button";
      del.setAttribute("aria-label", "Delete note: " + n.content.slice(0, 40));
      del.addEventListener("click", guard(async () => { await post("delete_note", { noteId: n.id }); await loadNotes(); }));
      row.append(el("span", null, n.content), del);
      list.append(row);
    }
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
    // Back-to-back AI answers to one message are side-by-side answers, shown in columns.
    let row = null;
    messages.forEach((m, i) => {
      const box = el("div", "m " + (m.role === "assistant" ? "assistant" : "user"));
      if (m.model) box.dataset.model = m.model;
      box.append(el("span", "who", m.role === "assistant" ? (MODEL_NAMES[m.model] || "AI") : "You"), document.createTextNode(m.content));
      const prev = messages[i - 1], next = messages[i + 1];
      const grouped = m.role === "assistant" && ((prev && prev.role === "assistant") || (next && next.role === "assistant"));
      if (!grouped) { row = null; list.append(box); return; }
      if (!row || !(prev && prev.role === "assistant")) { row = el("div", "cmp"); list.append(row); }
      row.append(box);
    });
    list.scrollTop = list.scrollHeight;
    $("cForm").hidden = false;
    const ms = status && status.models[thread.model];
    $("cNote").textContent = ms && !ms.ready ? (MODEL_NAMES[thread.model] || "This AI") + " can't reply yet: " + ms.reason
      : "Ctrl+Enter to send.";
    $("cRetry").hidden = !(messages.length && messages[messages.length - 1].role === "user" && ms && ms.ready);
    // Other ready AIs can answer the next message alongside this thread's AI (up to 3 in all; plugins are off then).
    const box = $("cCompare");
    box.replaceChildren(box.firstElementChild);
    const others = ms && ms.ready && status ? Object.keys(MODEL_NAMES).filter((k) => k !== thread.model && status.models[k] && status.models[k].ready) : [];
    for (const k of others) {
      const input = el("input"); input.type = "checkbox"; input.value = k;
      input.addEventListener("change", () => {
        const on = box.querySelectorAll("input:checked").length;
        for (const i of box.querySelectorAll("input")) i.disabled = !i.checked && on >= 2;
      });
      const label = el("label"); label.append(input, document.createTextNode(MODEL_NAMES[k]));
      box.append(label);
    }
    box.hidden = !others.length;
    await Promise.all([loadThreads(), loadStatus()]);
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
  $("nForm").addEventListener("submit", guard(async () => {
    await post("add_note", { projectId, content: $("nText").value });
    $("nText").value = "";
    await loadNotes();
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
    const ms = status && currentModel() && status.models[currentModel()];
    say(ms && ms.ready ? "Waiting for the reply…" : "");
    try {
      // With no AI ready the message is only saved; otherwise the server saves it and asks the thread's AI.
      const also = [...$("cCompare").querySelectorAll("input:checked")].map((i) => i.value);
      let failed = [];
      if (ms && ms.ready && also.length) {
        failed = (await post("compare", { threadId, content: text, models: [currentModel(), ...also] })).failed || [];
      } else if (ms && ms.ready) await post("chat", { threadId, content: text }).catch(async (e) => { await openThread(threadId); throw e; });
      else await post("add_message", { threadId, content: text });
      $("cText").value = "";
      say(failed.map((f) => (MODEL_NAMES[f.model] || f.model) + " didn't answer: " + f.error).join(" "), failed.length ? "err" : "");
      await openThread(threadId);
    } finally { $("cSend").disabled = false; }
  }));
  $("cRetry").addEventListener("click", guard(async () => {
    say("Waiting for the reply…");
    await post("chat", { threadId }).catch(async (e) => { await openThread(threadId); throw e; });
    say("");
    await openThread(threadId);
  }));
  function currentModel() { return $("cModel").dataset.model || null; }
  $("cText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("cForm").requestSubmit(); });

  guard(async () => { await loadStatus(); await loadProjects(); })();
})();
