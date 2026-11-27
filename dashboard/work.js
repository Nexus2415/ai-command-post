// Work from Linear, for the Home and Tasks pages. Read-only: POST /api/console (overview) and nothing else.
// All Linear text is rendered with textContent; no HTML is built from data.
(function (root) {
  "use strict";
  const NAMES = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", codex: "Codex" };
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
  const ownerName = (k) => NAMES[k] || "Unassigned";
  const label = (lane) => LABEL[lane] || "Unknown";
  function safeUrl(u) { const s = String(u || "").trim(); return /^https:\/\/linear\.app\/[^\s"'<>]*$/i.test(s) ? s : null; }
  function greeting(hour, name) {
    const part = hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    const n = String(name || "").trim().slice(0, 40);
    return n ? part + ", " + n : part;
  }
  const api = { counts, tab, activeWork, ownerName, label, safeUrl, greeting, TABS };
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
  };
  const CHEV = "M9 6l6 6-6 6";
  // One task as a row: owner icon, title, "ARN-12 · Claude" and a status pill; opens the task in Linear.
  function row(it) {
    const url = safeUrl(it.url);
    const a = el(url ? "a" : "div", "ax-row");
    if (url) { a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; }
    const ico = el("span", "ax-ico"); ico.append(icon(GLYPH[it.owner] || GLYPH.none));
    const main = el("span", "ax-main");
    main.append(el("strong", null, it.title || "Untitled task"));
    const sub = el("small");
    sub.append(el("span", null, (it.id ? it.id + " · " : "") + ownerName(it.owner)), el("span", "ax-pill " + (it.lane || ""), label(it.lane)));
    main.append(sub);
    a.append(ico, main);
    if (url) a.append(icon(CHEV, "ax-chev"));
    const li = el("li"); li.append(a); return li;
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
  Object.assign(api, { el, icon, row, load });
})(typeof window !== "undefined" ? window : globalThis);
