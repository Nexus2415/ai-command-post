// AI Command Post — website console (ARN-49).
// Reads POST /api/console (overview + thread) and sends POTUS intake to POST /api/intake.
// All Linear text is rendered with textContent; no innerHTML is ever built from data.
// Roster shows observed Linear workload only. Agent connection is never claimed to be live.
(function (root) {
  "use strict";
  const TABS = ["done", "active", "queued", "blocked", "review", "canceled"];
  const TAB_LABEL = { done: "Done", active: "Active", queued: "Queued", blocked: "Blocked", review: "Review", canceled: "Canceled" };
  const AGENT_NAME = { chatgpt: "ChatGPT", claude: "Claude", codex: "Codex", gemini: "Gemini", perplexity: "Perplexity" };
  const ID_RE = /^ARN-[1-9]\d{0,8}$/;

  // ---- pure helpers (unit-tested in test/console-ui.test.ts) ----
  function laneCounts(overview) {
    const lanes = (overview && overview.lanes) || {};
    const out = {};
    TABS.forEach(k => { out[k] = Array.isArray(lanes[k]) ? lanes[k].length : 0; });
    return out;
  }
  function laneIssues(overview, lane) {
    const issues = (overview && Array.isArray(overview.issues)) ? overview.issues : [];
    return issues.filter(i => i && i.lane === lane);
  }
  function connectionLabel(c) {
    // Only an explicit, server-verified state could ever change this; today there is none.
    return c === "verified" ? "Connection verified" : "Connection not verified";
  }
  function rosterRow(a) {
    const n = v => (Array.isArray(v) ? v.length : 0);
    return {
      key: String(a && a.key || ""), name: AGENT_NAME[a && a.key] || String(a && a.key || "Unknown"),
      connection: connectionLabel(a && a.connection),
      active: n(a && a.active), queued: n(a && a.queued), blocked: n(a && a.blocked), review: n(a && a.review),
      nextTask: a && typeof a.nextTask === "string" ? a.nextTask : null,
    };
  }
  function intakeBody(intent, text) {
    const t = String(text || "").trim();
    if (!t) throw new Error("Write something first.");
    if (intent !== "command" && intent !== "question") throw new Error("Pick Command or Question.");
    return { intent, text: t };
  }
  function errorMessage(status, body, what) {
    const msg = body && typeof body.error === "string" ? body.error : "";
    if (status === 404 && what === "intake") return "Intake endpoint isn't available yet (404). Nothing was sent.";
    if (status === 401) return "Password required.";
    const base = msg || ("Request failed (HTTP " + status + ").");
    return what === "intake" ? base + (/[.!?]$/.test(base) ? " " : ". ") + "Nothing was confirmed as received." : base;
  }
  function fmtTime(iso) {
    const t = Date.parse(iso || "");
    if (!isFinite(t)) return "unknown";
    return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  // Owner questions filed through intake are read-only, not unclaimed work.
  const isQuestion = it => /^\[Question\]/.test(String(it && it.title || ""));
  const ownerLabel = it => AGENT_NAME[it && it.owner] || (isQuestion(it) ? "Owner question · read-only" : "Unclaimed");
  // Only plain http(s) links are rendered; javascript:, data: and the like are dropped.
  function safeUrl(u) { const s = String(u || "").trim(); return /^https?:\/\/[^\s]+$/i.test(s) ? s : null; }
  const api = { safeUrl, ownerLabel, TABS, laneCounts, laneIssues, rosterRow, connectionLabel, intakeBody, errorMessage, isIssueId: s => ID_RE.test(String(s)) };
  root.ACPConsoleCore = api;
  if (typeof document === "undefined") return;

  // ---- DOM ----
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  let pendingKey = null, overview = null, tab = "active", intent = "command", busy = false, lastFocus = null, threadSeq = 0;

  // The password lives in memory for this tab only; it is never written to browser storage (ARN-53).
  let password = "";
  try { localStorage.removeItem("acp.pw"); } catch (e) {}

  async function post(path, body, retry) {
    let r;
    try {
      r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-acp-password": password }, body: JSON.stringify(body) });
    } catch (e) { const err = new Error("Network error: couldn't reach the server."); err.status = 0; throw err; }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && retry !== false) {
      const pw = window.prompt("Password for AI Command Post");
      if (pw) { password = pw; return post(path, body, false); }
    }
    if (!r.ok) { const err = new Error(errorMessage(r.status, j, path === "/api/intake" ? "intake" : "console")); err.status = r.status; throw err; }
    return j;
  }

  function setMsg(node, text, cls) { node.hidden = !text; node.className = "msg" + (cls ? " " + cls : ""); node.textContent = text || ""; }

  // Overview
  async function loadOverview() {
    $("cRefresh").disabled = true;
    $("cUpdated").textContent = overview ? "Refreshing…" : "Loading…";
    try {
      overview = await post("/api/console", { action: "overview" });
      setMsg($("cOverviewMsg"), overview.hasNextPage ? "Showing the latest 250 issues; older ones are not counted." : "", "warn");
      $("cUpdated").textContent = "Last updated " + fmtTime(overview.fetchedAt);
    } catch (e) {
      setMsg($("cOverviewMsg"), e.message + (overview ? " Showing the last data received." : ""), "err");
      $("cUpdated").textContent = overview ? "Last updated " + fmtTime(overview.fetchedAt) + " (stale)" : "Not loaded";
    } finally { $("cRefresh").disabled = false; }
    renderTabs(); renderList(); renderRoster();
  }

  function renderTabs() {
    const counts = laneCounts(overview), bar = $("cTabs");
    bar.replaceChildren();
    TABS.forEach(k => {
      const b = el("button", "ctab");
      b.type = "button"; b.setAttribute("role", "tab"); b.id = "ctab-" + k;
      b.setAttribute("aria-selected", String(k === tab)); b.setAttribute("aria-controls", "cList");
      b.tabIndex = k === tab ? 0 : -1;
      b.append(el("span", null, TAB_LABEL[k]), el("b", "mono", overview ? counts[k] : "—"));
      b.onclick = () => { tab = k; renderTabs(); renderList(); $("ctab-" + k).focus(); };
      b.onkeydown = ev => {
        const i = TABS.indexOf(k);
        let n = null;
        if (ev.key === "ArrowRight") n = TABS[(i + 1) % TABS.length];
        if (ev.key === "ArrowLeft") n = TABS[(i + TABS.length - 1) % TABS.length];
        if (ev.key === "Home") n = TABS[0];
        if (ev.key === "End") n = TABS[TABS.length - 1];
        if (n) { ev.preventDefault(); tab = n; renderTabs(); renderList(); $("ctab-" + n).focus(); }
      };
      bar.appendChild(b);
    });
  }

  function renderList() {
    const ol = $("cList");
    ol.replaceChildren();
    ol.setAttribute("aria-labelledby", "ctab-" + tab);
    if (!overview) { ol.appendChild(el("li", "empty", "Loading taskings…")); return; }
    const list = laneIssues(overview, tab).sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    if (!list.length) { ol.appendChild(el("li", "empty", "No " + TAB_LABEL[tab].toLowerCase() + " taskings.")); return; }
    list.forEach(it => {
      const li = el("li", "task"); li.dataset.ag = it.owner || "none";
      const body = el("div");
      const btn = el("button", "linkbtn", it.title || it.id);
      btn.type = "button"; btn.onclick = () => openThread(it.id);
      const meta = el("div", "meta");
      meta.append(el("span", null, it.id), el("span", "ag", ownerLabel(it)), el("span", null, it.status || ""));
      if (it.priority === 1 || it.priority === 2) meta.appendChild(el("span", "prio-" + it.priority, it.priority === 1 ? "Urgent" : "High"));
      meta.appendChild(el("span", null, "updated " + fmtTime(it.updatedAt)));
      body.append(btn, meta);
      li.append(el("span", "stripe"), body);
      ol.appendChild(li);
    });
  }

  function renderRoster() {
    const r = $("cRoster");
    r.replaceChildren();
    const agents = overview && Array.isArray(overview.agents) ? overview.agents : [];
    if (!agents.length) { r.appendChild(el("p", "empty", overview ? "No agents reported." : "Loading roster…")); return; }
    agents.map(rosterRow).forEach(a => {
      const card = el("div", "panel agent"); card.dataset.ag = a.key;
      card.appendChild(el("h3", null, a.name));
      card.appendChild(el("div", "chip off", a.connection));
      const stats = el("div", "stats");
      [["active", a.active], ["queued", a.queued], ["blocked", a.blocked], ["review", a.review]].forEach(([k, v]) => {
        const s = el("span"); s.append(el("b", null, v), document.createTextNode(k)); stats.appendChild(s);
      });
      card.appendChild(stats);
      const next = el("div", "note");
      if (a.nextTask && api.isIssueId(a.nextTask)) {
        next.append(document.createTextNode("Next: "));
        const b = el("button", "linkbtn mono", a.nextTask); b.type = "button"; b.onclick = () => openThread(a.nextTask);
        next.appendChild(b);
      } else next.textContent = "Next: none queued";
      card.appendChild(next);
      r.appendChild(card);
    });
  }

  // Detail thread
  async function openThread(id) {
    if (!api.isIssueId(id)) return;
    const seq = ++threadSeq;
    lastFocus = document.activeElement;
    const d = $("cDetail");
    d.hidden = false;
    $("cDetailTitle").textContent = id;
    $("cDetailMeta").textContent = "Loading thread…";
    $("cDetailBody").replaceChildren();
    $("cDetailClose").focus();
    try {
      const t = await post("/api/console", { action: "thread", identifier: id });
      if (seq !== threadSeq) return;
      const is = t.issue || {};
      $("cDetailTitle").textContent = (is.id || id) + " · " + (is.title || "");
      $("cDetailMeta").textContent = (is.status || "Unknown") + " · " + ownerLabel(is) + " · last updated " + fmtTime(t.fetchedAt);
      const body = $("cDetailBody");
      const href = safeUrl(is.url);
      if (href) { const a = el("a", null, "Open in Linear"); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; body.appendChild(a); }
      body.appendChild(el("pre", "desc", is.description || "No description."));
      const comments = Array.isArray(t.comments) ? t.comments : [];
      body.appendChild(el("h3", "eyebrow", "Comments (" + comments.length + (t.hasPreviousPage ? ", older not shown" : "") + ")"));
      if (!comments.length) body.appendChild(el("p", "empty", "No comments yet."));
      const ol = el("ol", "comments");
      comments.forEach(c => {
        const li = el("li");
        li.append(el("div", "meta", (c.author || "Unknown") + " · " + fmtTime(c.createdAt)), el("pre", "desc", c.body || ""));
        ol.appendChild(li);
      });
      body.appendChild(ol);
      const life = lifecycleBox(t.lifecycle, comments);
      if (life) body.prepend(life);
    } catch (e) {
      if (seq !== threadSeq) return;
      $("cDetailMeta").textContent = "";
      const m = el("div", "msg err"); m.textContent = e.message; $("cDetailBody").replaceChildren(m);
    }
  }
  // ARN-71: command status from recorded Linear evidence only. "Issue created" is never shown as "AI executed".
  function lifecycleBox(l, comments) {
    if (!l || typeof l !== "object") return null;
    const box = el("section", "lifecycle stage-" + String(l.stage || "unknown").replace(/[^a-z]/g, ""));
    box.setAttribute("aria-label", "Command status");
    box.append(el("div", "eyebrow", "Command status"), el("strong", null, l.label || "Unknown"), el("p", null, l.detail || ""));
    (Array.isArray(l.evidence) ? l.evidence : []).forEach(ev => {
      if (ev && ev.kind === "comment") {
        const c = comments.find(x => x.id === ev.commentId);
        if (c) box.append(el("div", "meta", "Recorded by " + (c.author || "Unknown") + " · " + fmtTime(c.createdAt)), el("pre", "desc", c.body || ""));
      } else if (ev && ev.kind === "issue" && api.isIssueId(ev.issue)) {
        const b = el("button", "link", "Open sub-task " + ev.issue); b.type = "button"; b.onclick = () => openThread(ev.issue); box.appendChild(b);
      }
    });
    return box;
  }
  function closeThread() {
    threadSeq++;
    $("cDetail").hidden = true;
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
  }

  // Composer
  function setIntent(k) {
    intent = k;
    document.querySelectorAll("#cIntent button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.intent === k)));
    $("cIntentNote").textContent = k === "question"
      ? "Question · read-only. It asks for an answer and must not change any tasking."
      : "Command · filed in Linear as a new command. The engine works it on a later run only while the engine is switched on; this page can't confirm that.";
    $("cSend").textContent = k === "question" ? "Ask question" : "Send command";
  }
  async function send() {
    if (busy) return;
    let body;
    try { body = intakeBody(intent, $("cText").value); } catch (e) { setMsg($("cSendMsg"), e.message, "warn"); return; }
    // One idempotency key per draft: a retry of the same text can't file a second issue.
    const draft = intent + "\n" + body.text;
    if (!pendingKey || pendingKey.draft !== draft) pendingKey = { draft, key: crypto.randomUUID() };
    body.idempotencyKey = pendingKey.key;
    busy = true; $("cSend").disabled = true; setMsg($("cSendMsg"), "Sending…", "");
    try {
      const j = await post("/api/intake", body);
      const ref = j && (j.identifier || j.id);
      pendingKey = null;
      setMsg($("cSendMsg"), (intent === "question" ? "Question received" : "Command received") + (ref ? " as " + ref : "") + (j && j.duplicate ? " (already filed earlier)" : "") + "." +
        (intent === "question" ? "" : " Issue created; AI execution not verified yet."), "ok");
      if (api.isIssueId(ref)) {
        const b = el("button", "link", "Check status of " + ref); b.type = "button"; b.onclick = () => openThread(ref);
        $("cSendMsg").appendChild(b);
      }
      $("cText").value = "";
      loadOverview();
    } catch (e) { setMsg($("cSendMsg"), e.message, "err"); }
    finally { busy = false; $("cSend").disabled = false; }
  }

  function start() {
    $("eveConsole").hidden = false;
    document.querySelectorAll("[data-legacy]").forEach(n => { n.hidden = true; });
    document.querySelectorAll("#cIntent button").forEach(b => { b.onclick = () => setIntent(b.dataset.intent); });
    setIntent("command");
    $("cSend").onclick = send;
    $("cText").addEventListener("keydown", ev => {
      // Ctrl/Cmd+Enter sends; plain Enter keeps newlines for multi-line commands.
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); send(); }
    });
    $("cRefresh").onclick = loadOverview;
    $("cDetailClose").onclick = closeThread;
    document.addEventListener("keydown", ev => { if (ev.key === "Escape" && !$("cDetail").hidden) closeThread(); });
    renderTabs(); renderList(); renderRoster();
    loadOverview();
    setInterval(() => { if (!document.hidden) loadOverview(); }, 60000);
  }
  root.ACPConsole = { start };
})(typeof window !== "undefined" ? window : globalThis);
