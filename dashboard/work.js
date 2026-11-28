// Work from Linear, for the Home and Tasks pages. Read-only: POST /api/console (overview) and nothing else.
// All Linear text is rendered with textContent; no HTML is built from data.
(function (root) {
  "use strict";
  const NAMES = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", codex: "Codex" };
  const GROUPS = { shared: "Shared Operations" };
  const LABEL = { active: "In progress", queued: "Not started", blocked: "Blocked", review: "Needs review", done: "Completed", canceled: "Canceled" };
  const RANK = { blocked: 0, active: 1, review: 2, queued: 3, done: 4, canceled: 5 };
  const TABS = { active: ["active", "queued", "blocked"], review: ["review"], done: ["done"] };

  // ---- pure helpers (unit-tested in test/new-look.test.ts) ----
  const tasksOf = (o) => (o && Array.isArray(o.issues) ? o.issues.filter((i) => i && typeof i === "object" && i.kind !== "question") : []);
  function counts(o) {
    const all = tasksOf(o);
    const n = (lane) => all.filter((i) => i.lane === lane).length;
    const c = { active: n("active"), queued: n("queued"), blocked: n("blocked"), review: n("review"), done: n("done") };
    c.open = c.active + c.queued + c.blocked;
    c.total = c.open + c.review + c.done;
    return c;
  }
  const prio = (p) => (Number.isInteger(p) && p > 0 ? p : 9);
  function byUrgency(a, b) {
    return (RANK[a.lane] ?? 9) - (RANK[b.lane] ?? 9) || prio(a.priority) - prio(b.priority) ||
      (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0);
  }
  // The tasks on one tab of the Tasks page: active (in progress, not started, blocked), review, or done.
  function tab(o, name) {
    const lanes = TABS[name] || [];
    const list = tasksOf(o).filter((i) => lanes.includes(i.lane));
    return name === "done"
      ? list.sort((a, b) => (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0))
      : list.sort(byUrgency);
  }
  // Home's "Active work": open and review tasks, most urgent first.
  const activeWork = (o, max) => tasksOf(o).filter((i) => ["active", "blocked", "review", "queued"].includes(i.lane)).sort(byUrgency).slice(0, max || 4);
  const ownerName = (k) => NAMES[k] || GROUPS[k] || "Unassigned";
  // ARN-145: who posted a "## Result (<AI>, done)" on the task, apart from who owns it. Only shown when it adds
  // something (no owner, or a different AI than the owner); no result comment shows nothing, never a guess.
  function resultBy(it) {
    const ex = it && Array.isArray(it.executedBy) ? it.executedBy.filter((k) => NAMES[k]) : [];
    if (!ex.length || (ex.length === 1 && ex[0] === it.owner)) return "";
    return "Result by " + ex.map((k) => NAMES[k]).join(", ");
  }
  const label = (lane) => LABEL[lane] || "Unknown";
  function safeUrl(u) { const s = String(u || "").trim(); return /^https:\/\/linear\.app\/[^\s"'<>]*$/i.test(s) ? s : null; }
  function greeting(hour, name) {
    const part = hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    const n = String(name || "").trim().slice(0, 40);
    return n ? part + ", " + n : part;
  }
  // The per-agent projection only timestamps its newest working task. Do not extend that
  // timestamp to other identifiers in the aggregated issues array.
  function taskLive(activity, it, now = Date.now()) {
    if (it?.lane !== "active" || !root.ACPLive || activity?.status !== "reported") return false;
    const ttl = activity.ttlMs, read = Date.parse(activity.readAt);
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 240000 || !Number.isFinite(read) ||
        read > now || now - read > ttl) return false;
    return ["claude", "chatgpt", "perplexity"].some(key => {
      const a = activity.agents?.[key], at = Date.parse(a?.at);
      return a?.issue === it.id && Number.isFinite(at) && at <= now && now - at <= ttl &&
        root.ACPLive.liveView(activity, key, now)?.state === "working" &&
        root.ACPLive.taskWorking(activity, it.id, now);
    });
  }
  const api = { counts, tab, activeWork, ownerName, resultBy, label, safeUrl, greeting, TABS, taskLive };
  root.ACPWork = api;
  if (typeof document === "undefined") return;

  // ---- DOM helpers shared by home.js and tasks.js ----
  const SVG = "http://www.w3.org/2000/svg";
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  function icon(d, cls) {
    const s = document.createElementNS(SVG, "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
    if (cls) s.setAttribute("class", cls);
    const p = document.createElementNS(SVG, "path"); p.setAttribute("d", d); s.append(p); return s;
  }
  const GLYPH = {
    claude: "M9 7l-5 5 5 5M15 7l5 5-5 5", chatgpt: "M4 6h16M4 12h10M4 18h7", perplexity: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l5 5",
    gemini: "M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z", codex: "M5 5h14v14H5zM9 9h6M9 13h6M9 17h3", none: "M12 4v8M12 16v.01M4 20h16L12 4z",
    shared: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v6M12 15v6M3 12h6M15 12h6",
  };
  // Original compact pixel character. No images, extra network requests, or model calls.
  // Motion is opt-in for a known pending request, never inferred from a Linear lane.
  function workerAvatar(typing = false) {
    const s = document.createElementNS(SVG, "svg");
    s.setAttribute("viewBox", "0 0 34 32");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("class", "ax-worker" + (typing === true ? " ax-typing" : ""));
    s.setAttribute("shape-rendering", "crispEdges");
    const path = (d, fill, parent = s) => {
      const p = document.createElementNS(SVG, "path");
      p.setAttribute("d", d); p.setAttribute("fill", fill); parent.append(p);
    };
    const group = cls => { const g = document.createElementNS(SVG, "g"); g.setAttribute("class", cls); s.append(g); return g; };
    path("M3 29H31V31H3Z", "#153847");
    path("M5 16H19V27H5Z", "#777b52");
    path("M5 17H9V20H5ZM12 20H16V23H12ZM7 24H11V27H7Z", "#a69872");
    path("M10 16H14V19H10ZM16 17H19V21H16ZM5 21H8V24H5Z", "#434b35");
    path("M6 3H19V15H6Z", "#cca17e");
    path("M5 2H17V5H21V8H7V12H5Z", "#40332c");
    path("M5 1H16V4H20V6H7V9H5Z", "#685c43");
    path("M11 9H13V11H11ZM17 9H19V11H17Z", "#272528");
    path("M14 13H17V14H14Z", "#754c3c");
    path("M4 6H7V13H4Z", "#279fb5");
    const left = group("ax-worker-left");
    path("M7 18H11V24H17V27H8Z", "#a69872", left);
    path("M15 24H19V27H15Z", "#d9b18c", left);
    const right = group("ax-worker-right");
    path("M17 18H20V24H24V26H18Z", "#505b40", right);
    path("M22 23H26V26H22Z", "#d9b18c", right);
    path("M20 17H33L30 27H17Z", "#65e2f1");
    path("M21 18H31L29 26H19Z", "#247a90");
    path("M15 27H30V29H15Z", "#69d9e7");
    path("M23 20H28V21H23ZM22 23H26V24H22Z", "#91f3ff");
    path("M27 23H29V24H27Z", "#d1fbff", group("ax-worker-cursor"));
    return s;
  }
  const CHEV = "M9 6l6 6-6 6";
  // Open the task locally. External navigation is an explicit, separate action.
  function row(it, activity) {
    const a = el("button", "ax-row");
    a.type = "button";
    a.setAttribute("aria-expanded", "false");
    const ico = el("span", "ax-ico");
    const assignedActive = it.lane === "active" && ["claude", "chatgpt", "perplexity", "codex"].includes(it.owner);
    const live = taskLive(activity, it) && !document.hidden;
    if (assignedActive || live) {
      ico.append(workerAvatar(false));
      ico.title = "Assigned work in progress; live execution not verified";
    } else ico.append(icon(GLYPH[it.owner] || GLYPH.none));
    const main = el("span", "ax-main");
    main.append(el("strong", null, it.title || "Untitled task"));
    const sub = el("small");
    const by = resultBy(it);
    sub.append(el("span", null, (it.id ? it.id + " · " : "") + ownerName(it.owner) + (by ? " · " + by : "")), el("span", "ax-pill " + (it.lane || ""), label(it.lane)));
    if (assignedActive || live) sub.append(el("span", "ax-live-unknown", live ? "Recent worker heartbeat" : "Live activity unverified"));
    main.append(sub);
    a.append(ico, main);
    a.append(icon(CHEV, "ax-chev"));
    const li = el("li");
    const detail = el("div", "ax-task-detail");
    detail.hidden = true;
    a.addEventListener("click", () => {
      const open = detail.hidden;
      detail.hidden = !open;
      a.setAttribute("aria-expanded", String(open));
      if (open) showTask(detail, it);
    });
    li.append(a, detail);
    li._workItem = it;
    li.dataset.workerTask = it.id;
    updateTaskMotion(li, activity, it);
    return li;
  }
  // Only a real outstanding read animates. A Linear status is not a worker heartbeat.
  async function showTask(host, it) {
    const token = {};
    host._taskRead = token;
    host.replaceChildren();
    const url = safeUrl(it.url);
    if (url) {
      const link = el("a", "ax-linear-link", "Open in Linear ↗");
      link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer";
      host.append(link);
    }
    const body = el("div", "ax-task-body");
    host.append(body);
    const loading = el("p", "ax-reading", "Reading task details…");
    loading.setAttribute("role", "status");
    body.append(loading);
    if (!/^ARN-[1-9]\\d{0,8}$/.test(String(it.id))) {
      body.replaceChildren(el("p", "ax-muted", "Task details unavailable: invalid issue identifier."));
      return;
    }
    try {
      const r = await fetch("/api/console", { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" }, body: JSON.stringify({action:"thread", identifier:it.id}),
        signal: AbortSignal.timeout(20000) });
      if (host._taskRead !== token || !host.isConnected) return;
      if (r.status === 401 && root.ACPSession) { root.ACPSession.expired(); return; }
      if (!r.ok) throw new Error("Couldn't load task details.");
      const j = await r.json();
      if (host._taskRead !== token || !host.isConnected) return;
      if (j.issue?.id !== it.id || !Array.isArray(j.comments)) throw new Error("Task details could not be verified.");
      body.replaceChildren();
      body.append(el("p", "ax-muted", label(j.issue.lane) + " · Execution activity not verified"));
      const description = String(j.issue.description || "").trim();
      const first = description.split(/\n\s*\n/).find(p => p.trim()) || "No description.";
      const summary = first.length > 500 ? first.slice(0, 497) + "…" : first;
      body.append(el("h3", null, "Task summary"), el("p", "ax-task-copy", summary));
      if (description && description !== summary) {
        const more = el("details"); more.append(el("summary", null, "Full task description"),
          el("p", "ax-task-copy", description)); body.append(more);
      }
      const when = Date.parse(j.fetchedAt);
      if (Number.isFinite(when)) body.append(el("p", "ax-muted", "Read from Linear: " + new Date(when).toLocaleString()));
      body.append(el("h3", null, "Latest updates"));
      if (j.hasPreviousPage) body.append(el("p", "ax-muted", "Earlier updates are not included."));
      if (!j.comments.length) body.append(el("p", "ax-muted", "No updates returned."));
      for (const c of j.comments.slice(-5).reverse()) {
        const item = el("div", "ax-task-update");
        item.append(el("strong", null, String(c.author || "Unknown") + " · " + String(c.createdAt || "")),
          el("p", "ax-task-copy", String(c.body || "").slice(0, 6000)));
        body.append(item);
      }
    } catch {
      if (host._taskRead !== token || !host.isConnected) return;
      body.replaceChildren(el("p", "ax-muted", "Couldn't load task details. Status is unverified."));
      const retry = el("button", "ax-btn ghost", "Retry");
      retry.type = "button"; retry.addEventListener("click", () => showTask(host, it)); body.append(retry);
    }
  }
  function updateTaskMotion(li, activity, it) {
    const live = !document.hidden && taskLive(activity, it);
    const sprite = li.querySelector(".ax-worker");
    if (sprite) sprite.classList.toggle("ax-typing", live);
    const status = li.querySelector(".ax-live-unknown");
    if (status) status.textContent = live ? "Recent worker heartbeat" : "Live activity unverified";
    const ico = li.querySelector(".ax-ico");
    if (ico && sprite) ico.title = live ? "Recent authenticated worker heartbeat" : "Live execution not verified";
  }
  // One read-only board refresh per minute, no additional model request or per-task polling.
  // Keep expanded rows and focus intact; expire cached motion locally between reads.
  function watchActivity(initial) {
    let report = initial?.activity, items = new Map(tasksOf(initial).map(it => [it.id, it])), busy = false;
    const sync = () => {
      for (const li of document.querySelectorAll("[data-worker-task]"))
        updateTaskMotion(li, report, items.get(li.dataset.workerTask));
    };
    const refresh = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const o = await load();
        report = o?.activity;
        items = new Map(tasksOf(o).map(it => [it.id, it]));
      } catch { report = null; }
      finally { busy = false; sync(); }
    };
    setInterval(sync, 1000);
    setInterval(refresh, 60000);
    document.addEventListener("visibilitychange", () => {
      report = null; sync();
      if (!document.hidden) refresh();
    });
    sync();
  }
  async function load() {
    let r;
    try {
      r = await fetch("/api/console", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "overview" }) });
    } catch (e) { throw new Error("Network error: couldn't reach the server."); }
    if (r.status === 401 && root.ACPSession) return root.ACPSession.expired();
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "Couldn't load tasks (" + r.status + ").");
    return j;
  }
  Object.assign(api, { el, icon, row, load, showTask, workerAvatar, watchActivity });
})(typeof window !== "undefined" ? window : globalThis);
