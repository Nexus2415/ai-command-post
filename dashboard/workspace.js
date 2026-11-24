// Workspace page (Phase 1 steps 2-3): projects, threads and the open conversation, from /api/workspace.
// Everything is rendered with textContent and never parsed as HTML, because messages are untrusted text.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const MODEL_NAMES = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity" };
  let projectId = null, threadId = null, busy = false, status = null, files = [], lastState = null, threadPrivate = null;
  // Same markers as api/_lib/workspace-roundtable.js.
  const CRITIQUE_MARK = "[Roundtable round 2: critique and revised answer]", SYNTHESIS_MARK = "[Roundtable final answer]";
  const kindOf = (m) => m.role !== "assistant" ? "user" : m.content.startsWith(SYNTHESIS_MARK) ? "synthesis"
    : m.content.startsWith(CRITIQUE_MARK) ? "critique" : m.content.startsWith("(The AI provider failed") ? "failed" : "answer";
  // After the last message from the owner: how many AIs answered, critiqued, and whether a conclusion exists.
  function roundState(messages) {
    let i = messages.length - 1;
    while (i >= 0 && messages[i].role !== "user") i--;
    if (i < 0) return null;
    const after = messages.slice(i + 1).map(kindOf);
    return { answers: after.filter((k) => k === "answer").length, critiques: after.filter((k) => k === "critique").length, done: after.includes("synthesis") };
  }

  // The password lives in memory for this tab only; it is never written to browser storage (ARN-53).
  let password = "";
  // Requests still waiting. "Stop everything" cancels them all at once on this page; the server stops the rest.
  const inflight = new Set();
  let halted = false;

  async function post(action, args, retry) {
    let r;
    const ctl = new AbortController();
    inflight.add(ctl);
    try {
      r = await fetch("/api/workspace", { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json", "x-acp-password": password }, body: JSON.stringify({ action, args: args || {} }) });
    } catch (e) {
      if (ctl.signal.aborted) throw new Error("Stopped. Nothing further will run until AI is turned back on.");
      throw new Error("Network error: couldn't reach the server.");
    } finally { inflight.delete(ctl); }
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
    if (status.control) stopSwitch.show(status.control);
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
      (t) => t.title, (t) => (MODEL_NAMES[t.model] || t.model) + " · " + when(t.updated_at) + (t.private === false ? "" : " · Private"), (t) => openThread(t.id));
  }

  function closeThread() {
    $("cH").textContent = "No thread open";
    $("cModel").hidden = true;
    $("cPrivacy").hidden = true;
    $("cForm").hidden = true;
    $("mList").replaceChildren();
  }

  async function openThread(id) {
    threadId = id;
    const { thread, messages } = await post("get_thread", { threadId: id });
    $("cH").textContent = thread.title;
    const chip = $("cModel"); chip.hidden = false; chip.dataset.model = thread.model;
    chip.lastElementChild.textContent = MODEL_NAMES[thread.model] || thread.model;
    showPrivacy(thread.private);
    const list = $("mList"); list.replaceChildren();
    if (!messages.length) list.append(el("p", "empty", "No messages yet."));
    // Back-to-back AI answers to one message are side-by-side answers, shown in columns. A roundtable's critique
    // round gets its own row, and its conclusion is shown full width.
    let row = null, rowKind = null;
    messages.forEach((m) => {
      const kind = kindOf(m);
      const box = el("div", "m " + (m.role === "assistant" ? "assistant" : "user") + (kind === "synthesis" ? " synth" : ""));
      if (m.model) box.dataset.model = m.model;
      const name = m.role === "assistant" ? (MODEL_NAMES[m.model] || "AI") : "You";
      box.append(el("span", "who", kind === "critique" ? name + " · review and revised answer"
        : kind === "synthesis" ? "Recommendation · written by " + name : name));
      showContent(box, kind === "critique" || kind === "synthesis" ? m.content.replace(/^\[Roundtable[^\]\n]*\]\n?/, "") : m.content);
      if (m.role !== "assistant" || kind === "synthesis") {
        row = null; rowKind = null;
        if (kind === "synthesis") list.append(el("div", "round", "Step 3 · Final answer"));
        list.append(box); return;
      }
      if (!row || rowKind !== kind) {
        row = el("div", "cmp"); rowKind = kind; row.dataset.kind = kind;
        if (kind === "critique") list.append(el("div", "round", "Step 2 · Reviewing each other"));
        list.append(row);
      }
      row.append(box);
    });
    // Unwrap rows holding a single plain answer, so one-AI replies look like a normal chat.
    for (const r of list.querySelectorAll(".cmp")) if (r.children.length === 1 && r.dataset.kind !== "critique") r.replaceWith(r.firstElementChild);
    lastState = roundState(messages);
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
    $("cRoundRow").hidden = !others.length;
    $("cRound").checked = false;
    // A side-by-side answer (or a roundtable that stopped part way) can be taken through the remaining rounds.
    $("cDiscuss").hidden = !(lastState && lastState.answers >= 2 && !lastState.done);
    $("cDiscuss").textContent = lastState && lastState.critiques ? "Finish roundtable" : "Discuss these answers (roundtable)";
    await Promise.all([loadThreads(), loadStatus()]);
  }

  // Shared or private, at a glance. Shared: other threads' AIs in this project may draw on this thread. Private:
  // no other thread's AI can see it. Unknown (the database update isn't applied yet): treated as private.
  function showPrivacy(p) {
    threadPrivate = p;
    const b = $("cPrivacy");
    b.hidden = false;
    b.disabled = p !== true && p !== false;
    b.dataset.state = p === false ? "shared" : "private";
    b.textContent = p === false ? "Shared in this project" : p === true ? "Private" : "Private (setup needed)";
    b.title = p === false ? "Other threads' AIs in this project can draw on this thread. Click to make it private."
      : p === true ? "No other thread's AI can see this thread. Click to share it with this project again."
      : "Sharing between threads needs a one-time database update; until then no thread is shared.";
    b.setAttribute("aria-label", b.textContent + ". " + b.title);
  }

  // An answer that drew on other threads ends with this line (same as api/_lib/workspace-shared.js); it is shown
  // as a small "Drew on" note under the answer.
  const SOURCES_LINE = /\n*Drew on other threads: ([^\n]*)/;
  // Attached files arrive folded into the message between markers; each shows as a collapsible block.
  const FILE_BLOCK = /<<<file: ([^\n]{1,120})>>>\n([\s\S]*?)\n<<<end of file>>>/g;
  function showContent(box, content) {
    const src = content.match(SOURCES_LINE);
    if (src) content = content.replace(SOURCES_LINE, "");
    showText(box, content);
    if (src) box.append(el("div", "drew", "Drew on: " + src[1]));
  }
  function showText(box, content) {
    let at = 0;
    for (const f of content.matchAll(FILE_BLOCK)) {
      const before = content.slice(at, f.index).trim();
      if (before) box.append(document.createTextNode(before));
      const d = el("details", "file");
      d.append(el("summary", "", "File: " + f[1]), el("pre", "", f[2]));
      box.append(d);
      at = f.index + f[0].length;
    }
    const rest = content.slice(at).trim();
    if (rest || at === 0) box.append(document.createTextNode(at === 0 ? content : rest));
  }

  // Text files picked for the next message, up to 3. They are read here and sent as text, never uploaded as files.
  function showFiles() {
    const row = $("cFiles"); row.replaceChildren();
    files.forEach((f, i) => {
      const chip = el("span", "chip", f.name + " (" + f.text.length.toLocaleString() + " characters)");
      const x = el("button", "", "Remove"); x.type = "button"; x.setAttribute("aria-label", "Remove " + f.name);
      x.addEventListener("click", () => { files.splice(i, 1); showFiles(); });
      chip.append(x); row.append(chip);
    });
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
  $("cAttach").addEventListener("click", () => $("cFile").click());
  $("cFile").addEventListener("change", guard(async () => {
    try {
      for (const file of $("cFile").files) {
        if (files.length >= 3) throw new Error("Attach at most 3 files.");
        if (file.size > 200000) throw new Error(file.name + " is too big. Text files up to 30,000 characters work.");
        const text = await file.text();
        if (!text.trim() || text.includes("\u0000")) throw new Error(file.name + " isn't a text file, or it's empty.");
        if (text.length > 30000) throw new Error(file.name + " is over 30,000 characters. Attach a shorter file.");
        files.push({ name: file.name.replace(/[\u0000-\u001f<>]/g, "_").slice(0, 120), text });
      }
    } finally { $("cFile").value = ""; showFiles(); }
  }));
  $("cForm").addEventListener("submit", guard(async () => {
    const text = $("cText").value;
    if (!text.trim() && !files.length) return;
    const attachments = files.length ? files : undefined;
    $("cSend").disabled = true;
    const ms = status && currentModel() && status.models[currentModel()];
    say(ms && ms.ready ? "Waiting for the reply…" : "");
    try {
      // With no AI ready the message is only saved; otherwise the server saves it and asks the thread's AI.
      const also = [...$("cCompare").querySelectorAll("input:checked")].map((i) => i.value);
      let failed = [];
      if (ms && ms.ready && also.length && $("cRound").checked) {
        const ran = await roundtable(text, attachments, [currentModel(), ...also]);
        if (ran) { $("cText").value = ""; files = []; showFiles(); }
        return;
      }
      if (ms && ms.ready && also.length) {
        failed = (await post("compare", { threadId, content: text, attachments, models: [currentModel(), ...also] })).failed || [];
      } else if (ms && ms.ready) await post("chat", { threadId, content: text, attachments }).catch(async (e) => { await openThread(threadId); throw e; });
      else await post("add_message", { threadId, content: text, attachments });
      $("cText").value = ""; files = []; showFiles();
      say(failed.map((f) => (MODEL_NAMES[f.model] || f.model) + " didn't answer: " + f.error).join(" "), failed.length ? "err" : "");
      await openThread(threadId);
    } finally { $("cSend").disabled = halted; }
  }));
  $("cRetry").addEventListener("click", guard(async () => {
    say("Waiting for the reply…");
    await post("chat", { threadId }).catch(async (e) => { await openThread(threadId); throw e; });
    say("");
    await openThread(threadId);
  }));
  // Roundtable mode: round 1 (each AI answers), round 2 (each critiques the others and revises), round 3 (the
  // lead writes one conclusion). One request per round; the server checks the budget before each one.
  const who = (list) => (list || []).map((f) => (MODEL_NAMES[f.model] || f.model) + " dropped out: " + f.error).join(" ");
  async function roundtable(text, attachments, models) {
    const est = await post("roundtable_estimate", { threadId, content: text, attachments, models });
    if (!est.fits) throw new Error("Roundtable not started: it could cost up to " + money(est.estimate.total) + ". " + est.why);
    const names = models.map((m) => MODEL_NAMES[m] || m).join(", ");
    if (!window.confirm("Run a roundtable with " + names + "?\n\nThree rounds. Worst case " + money(est.estimate.total) +
      " (usually much less). This thread has used " + money(est.budget.threadSpent) + " of " + money(est.budget.thread) + ".")) return false;
    say("Round 1 of 3: each AI answers on its own…", "warn");
    const r1 = await post("roundtable", { step: "start", threadId, content: text, attachments, models });
    await openThread(threadId);
    return finishRoundtable(models, r1.roundtableUsd, who(r1.failed));
  }
  async function finishRoundtable(models, soFar, dropped) {
    const notes = dropped ? [dropped] : [];
    const st = lastState || { critiques: 0 };
    if (!st.critiques) {
      say("Round 2 of 3: the AIs read and critique each other's answers… (" + money(soFar) + " so far)", "warn");
      try {
        const r2 = await post("roundtable", { step: "critique", threadId });
        soFar = r2.roundtableUsd; if (r2.failed && r2.failed.length) notes.push(who(r2.failed));
      } catch (e) { await openThread(threadId); throw e; }
      await openThread(threadId);
    }
    say("Round 3 of 3: the lead AI writes one conclusion… (" + money(soFar) + " so far)", "warn");
    try {
      const r3 = await post("roundtable", { step: "synthesize", threadId, models });
      notes.push("Roundtable done. It cost " + money(r3.roundtableUsd) + ".");
      if (r3.failed && r3.failed.length) notes.unshift(who(r3.failed));
    } catch (e) { await openThread(threadId); throw e; }
    await openThread(threadId);
    say(notes.join(" "), notes.length > 1 ? "warn" : "");
    return true;
  }
  // Make this thread private, or shared with the project again. Reversible at any time.
  $("cPrivacy").addEventListener("click", guard(async () => {
    if (!threadId || (threadPrivate !== true && threadPrivate !== false)) return;
    const { thread } = await post("set_private", { threadId, private: !threadPrivate });
    showPrivacy(thread.private);
    await loadThreads();
  }));
  $("cDiscuss").addEventListener("click", guard(async () => {
    $("cDiscuss").disabled = true;
    try { await finishRoundtable(null, 0, ""); } finally { $("cDiscuss").disabled = halted; }
  }));
  // The Stop everything switch. Stopping cancels this page's waiting requests (a roundtable stops between rounds)
  // and disables sending; the server refuses all AI work until it is turned back on.
  function setHalted(s) {
    halted = Boolean(s.stopped);
    // Runs before the stop request is sent, so only the page's earlier requests are cancelled.
    if (halted && s.local) for (const c of [...inflight]) c.abort();
    $("cSend").disabled = halted;
    $("cRetry").disabled = halted;
    $("cDiscuss").disabled = halted;
  }
  const stopSwitch = window.ACPStopSwitch.mount($("stopSwitch"), { post, onChange: setHalted });
  function currentModel() { return $("cModel").dataset.model || null; }
  $("cText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("cForm").requestSubmit(); });

  guard(async () => { await loadStatus(); await loadProjects(); })();
})();
