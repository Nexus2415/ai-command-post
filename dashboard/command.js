// AI Command Post — command tree view: an orchestrator node with a branch to each AI and its tasks.
// Read-only: it calls POST /api/console (overview) and nothing else. No intake, no thread writes, no model calls.
// All Linear text is rendered with textContent; no HTML is ever built from data.
// Agent status is derived from Linear workload only. It never claims an agent is connected or that a worker is live.
(function (root) {
  "use strict";
  const AGENTS = [
    { key: "chatgpt", name: "ChatGPT", role: "Coordinates, plans and breaks ties", glyph: "M4 6h16M4 12h10M4 18h7" },
    { key: "claude", name: "Claude", role: "Writes code and architecture", glyph: "M9 7l-5 5 5 5M15 7l5 5-5 5" },
    { key: "perplexity", name: "Perplexity", role: "Research and independent review", glyph: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l5 5" },
    { key: "gemini", name: "Gemini", role: "Second-opinion review", suspended: true, glyph: "M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" },
    { key: "codex", name: "Codex", role: "Code review on pull requests", glyph: "M5 5h14v14H5zM9 9h6M9 13h6M9 17h3" },
    { key: "none", name: "Unclaimed", role: "Open work with no AI owner yet", glyph: "M12 4v8M12 16v.01M4 20h16L12 4z" },
  ];
  const OPEN = ["active", "queued", "blocked", "review"];
  const PILL = {
    running: "In progress", blocked: "Blocked", review: "In review", queued: "Queued", complete: "Complete", idle: "Idle",
    suspended: "Suspended",
  };
  const ID_RE = /^ARN-[1-9]\d{0,8}$/;

  // ---- pure helpers (unit-tested in test/command-view.test.ts) ----
  const list = o => (o && Array.isArray(o.issues) ? o.issues.filter(i => i && typeof i === "object") : []);
  const ownerKey = it => (AGENTS.some(a => a.key === it.owner && a.key !== "none") ? it.owner : "none");

  function agentStats(overview, key) {
    const mine = list(overview).filter(i => ownerKey(i) === key && i.kind !== "question");
    const n = lane => mine.filter(i => i.lane === lane).length;
    const s = { active: n("active"), queued: n("queued"), blocked: n("blocked"), review: n("review"), done: n("done") };
    const total = s.active + s.queued + s.blocked + s.review + s.done;
    s.total = total;
    s.percent = total ? Math.round((s.done / total) * 100) : 0;
    s.open = s.active + s.queued + s.blocked + s.review;
    // Gemini is turned off by the owner (SUSPENDED_AGENTS in src/config.ts); old Linear ownership never makes it look active.
    const agent = AGENTS.find(a => a.key === key);
    s.status = agent && agent.suspended ? "suspended" :
      s.blocked ? "blocked" : s.active ? "running" : s.review ? "review" : s.queued ? "queued" : s.done ? "complete" : "idle";
    s.tasks = mine.filter(i => OPEN.includes(i.lane)).sort(byUrgency);
    return s;
  }
  // Blocked first, then working, review, queued; inside a lane, priority (1 = urgent, 0 = none) then most recent.
  const LANE_RANK = { blocked: 0, active: 1, review: 2, queued: 3, done: 4, canceled: 5 };
  const prio = p => (Number.isInteger(p) && p > 0 ? p : 9);
  function byUrgency(a, b) {
    return (LANE_RANK[a.lane] ?? 9) - (LANE_RANK[b.lane] ?? 9) || prio(a.priority) - prio(b.priority) ||
      (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0);
  }
  // AIs that Linear shows with open tasks. Done-only and suspended AIs are not counted; this is workload, not live workers.
  function aisWithOpenTasks(overview) {
    return AGENTS.filter(a => a.key !== "none" && !a.suspended && agentStats(overview, a.key).open > 0).length;
  }
  function totals(overview) {
    const all = list(overview).filter(i => i.kind !== "question");
    const n = lane => all.filter(i => i.lane === lane).length;
    const t = { active: n("active"), queued: n("queued"), blocked: n("blocked"), review: n("review"), done: n("done"), canceled: n("canceled") };
    // Canceled work is neither completed nor failed; it is left out of the completion rate.
    t.counted = t.active + t.queued + t.blocked + t.review + t.done;
    t.rate = t.counted ? Math.round((t.done / t.counted) * 100) : 0;
    return t;
  }
  function queue(overview, max) {
    return list(overview).filter(i => OPEN.includes(i.lane) && i.kind !== "question").sort(byUrgency).slice(0, max || 6);
  }
  function activity(overview, max) {
    return list(overview).filter(i => i.updatedAt && isFinite(Date.parse(i.updatedAt)))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, max || 8);
  }
  function laneStatus(lane) {
    return { active: "running", blocked: "blocked", review: "review", queued: "queued", done: "complete" }[lane] || "idle";
  }
  function safeUrl(u) { const s = String(u || "").trim(); return /^https:\/\/linear\.app\/[^\s]*$/i.test(s) ? s : null; }
  function agentName(key) { const a = AGENTS.find(x => x.key === key); return a ? a.name : "Unclaimed"; }
  function errorMessage(status, body) {
    if (status === 401) return "Password required.";
    const msg = body && typeof body.error === "string" ? body.error : "";
    return msg || "Request failed (HTTP " + status + ").";
  }
  const api = { AGENTS, PILL, agentStats, aisWithOpenTasks, totals, queue, activity, laneStatus, safeUrl, agentName, errorMessage, isIssueId: s => ID_RE.test(String(s)) };
  root.ACPCommandCore = api;
  if (typeof document === "undefined") return;

  // ---- DOM ----
  const $ = id => document.getElementById(id);
  const SVG = "http://www.w3.org/2000/svg";
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const svg = (tag, attrs) => { const e = document.createElementNS(SVG, tag); Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, String(v))); return e; };
  let overview = null, password = "";
  try { localStorage.removeItem("acp.pw"); } catch (e) {}

  async function post(body, retry) {
    let r;
    try {
      r = await fetch("/api/console", { method: "POST", headers: { "content-type": "application/json", "x-acp-password": password }, body: JSON.stringify(body) });
    } catch (e) { throw new Error("Network error: couldn't reach the server."); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && retry !== false) {
      const pw = window.prompt("Password for AI Command Post");
      if (pw) { password = pw; return post(body, false); }
    }
    if (!r.ok) throw new Error(errorMessage(r.status, j));
    return j;
  }
  function fmtTime(iso, withDay) {
    const t = Date.parse(iso || "");
    if (!isFinite(t)) return "--:--";
    return new Date(t).toLocaleString([], withDay ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }
  function icon(path, cls) {
    const s = svg("svg", { viewBox: "0 0 24 24", class: cls || "glyph", "aria-hidden": "true" });
    s.appendChild(svg("path", { d: path }));
    return s;
  }
  function pill(status) { const p = el("span", "pill s-" + status); p.append(el("span", "dot"), document.createTextNode(PILL[status])); return p; }
  function taskLink(it, cls) {
    const href = safeUrl(it.url);
    const a = el(href ? "a" : "span", cls, it.title || it.id);
    if (href) { a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; }
    return a;
  }
  function ring(node, pct, label) {
    node.replaceChildren();
    const r = 42, c = 2 * Math.PI * r;
    const s = svg("svg", { viewBox: "0 0 100 100", class: "ring", role: "img", "aria-label": label });
    s.append(svg("circle", { cx: 50, cy: 50, r, class: "ring-track" }),
      svg("circle", { cx: 50, cy: 50, r, class: "ring-fill", "stroke-dasharray": c, "stroke-dashoffset": c * (1 - Math.max(0, Math.min(100, pct)) / 100), transform: "rotate(-90 50 50)" }));
    node.appendChild(s);
  }

  function renderStatus() {
    const t = totals(overview);
    ring($("gRing"), overview ? (t.counted ? ((t.active + t.review) / t.counted) * 100 : 0) : 0, "Share of open work being worked now");
    $("gAgents").textContent = overview ? aisWithOpenTasks(overview) : "—";
    const rows = $("gRows"); rows.replaceChildren();
    [["running", "In progress", t.active], ["review", "In review", t.review], ["queued", "Queued", t.queued], ["blocked", "Blocked", t.blocked], ["complete", "Complete", t.done]]
      .forEach(([s, label, v]) => { const li = el("li", "s-" + s); li.append(el("span", "dot"), el("span", null, label), el("b", "mono", overview ? v : "—")); rows.appendChild(li); });
    // Task flow bars: one bar per lane, scaled to the largest lane.
    const flow = $("gFlow"); flow.replaceChildren();
    const lanes = [["queued", t.queued], ["running", t.active], ["review", t.review], ["blocked", t.blocked], ["complete", t.done]];
    const max = Math.max(1, ...lanes.map(x => x[1]));
    lanes.forEach(([s, v]) => {
      const col = el("div", "fcol s-" + s);
      const bar = el("i"); bar.style.height = Math.max(4, (v / max) * 100) + "%";
      col.append(el("b", "mono", overview ? v : "—"), bar, el("span", null, PILL[s]));
      flow.appendChild(col);
    });
    const done = $("gDone");
    ring(done, t.rate, "Completion rate " + t.rate + " percent");
    const big = el("b", "ring-label mono", overview ? t.rate + "%" : "—"); done.appendChild(big);
    const dl = $("gRate"); dl.replaceChildren();
    [["Total tasks", t.counted], ["Completed", t.done], ["In progress", t.active + t.review], ["Blocked", t.blocked]].forEach(([k, v]) => {
      dl.append(el("dt", null, k), el("dd", "mono", overview ? v : "—"));
    });
  }

  function agentCard(a) {
    const s = agentStats(overview, a.key);
    const card = el("article", "hud node agent-node s-" + s.status);
    card.dataset.ag = a.key; card.id = "node-" + a.key;
    card.setAttribute("aria-label", a.name + ": " + PILL[s.status]);
    const head = el("header");
    const badge = el("span", "badge"); badge.appendChild(icon(a.glyph));
    const title = el("div");
    title.append(el("h3", null, a.name), pill(s.status));
    head.append(badge, title);
    const prog = el("div", "prog");
    const bar = el("div", "bar"); const fill = el("i"); fill.style.width = s.percent + "%"; bar.appendChild(fill);
    bar.setAttribute("role", "img"); bar.setAttribute("aria-label", s.percent + "% of assigned tasks done");
    prog.append(bar, el("b", "mono", s.percent + "%"));
    const body = el("div", "nbody");
    const bullets = el("ul", "bullets");
    if (!s.tasks.length) bullets.appendChild(el("li", "muted", a.role));
    s.tasks.slice(0, 3).forEach(it => { const li = el("li"); li.dataset.s = laneStatus(it.lane); li.appendChild(taskLink(it)); bullets.appendChild(li); });
    const stats = el("dl", "stats");
    [["Active", s.active], ["Queued", s.queued], ["Blocked", s.blocked], ["Done", s.done]].forEach(([k, v]) => stats.append(el("dt", null, k), el("dd", "mono", v)));
    body.append(bullets, stats);
    card.append(head, prog, body);
    // Branches: every open task for this AI, folded away until asked for.
    if (s.tasks.length > 3) {
      const more = el("details", "branches");
      more.appendChild(el("summary", null, "Show all " + s.tasks.length + " open tasks"));
      const ol = el("ol");
      s.tasks.forEach(it => { const li = el("li"); li.dataset.s = laneStatus(it.lane); li.append(el("span", "mono", it.id), taskLink(it)); ol.appendChild(li); });
      more.appendChild(ol);
      more.addEventListener("toggle", drawLinks);
      card.appendChild(more);
    }
    return card;
  }

  function renderTree() {
    const left = $("treeLeft"), right = $("treeRight");
    left.replaceChildren(); right.replaceChildren();
    AGENTS.forEach((a, i) => (i % 2 ? right : left).appendChild(agentCard(a)));
    const t = totals(overview);
    $("orbOpen").textContent = overview ? (t.active + t.queued + t.blocked + t.review) + " open" : "Loading…";
    requestAnimationFrame(drawLinks);
  }

  // Curved connectors from the orchestrator to each agent card, recomputed whenever the layout moves.
  function drawLinks() {
    const host = $("tree"), layer = $("links"), orb = $("orb");
    if (!host || !layer || !orb) return;
    layer.replaceChildren();
    const box = host.getBoundingClientRect();
    if (!box.width || getComputedStyle(layer).display === "none") return;
    layer.setAttribute("viewBox", "0 0 " + box.width + " " + box.height);
    const o = orb.getBoundingClientRect();
    const ox = o.left + o.width / 2 - box.left, oy = o.top + o.height / 2 - box.top;
    AGENTS.forEach(a => {
      const n = $("node-" + a.key); if (!n) return;
      const r = n.getBoundingClientRect();
      const onLeft = r.left + r.width / 2 < o.left + o.width / 2;
      const x = (onLeft ? r.right : r.left) - box.left, y = r.top + Math.min(r.height / 2, 60) - box.top;
      const sx = ox + (onLeft ? -1 : 1) * o.width * 0.42, sy = oy + (y - oy) * 0.25;
      const mid = (sx + x) / 2;
      const status = (n.className.match(/s-(\w+)/) || [])[1] || "idle";
      const d = "M" + sx + " " + sy + " C" + mid + " " + sy + " " + mid + " " + y + " " + x + " " + y;
      layer.append(svg("path", { d, class: "link glow s-" + status }), svg("path", { d, class: "link s-" + status }),
        svg("circle", { cx: x, cy: y, r: 3.5, class: "tip s-" + status }));
    });
  }

  function renderQueue() {
    const ol = $("qList"); ol.replaceChildren();
    const q = queue(overview, 6);
    if (!overview) { ol.appendChild(el("li", "muted", "Loading…")); return; }
    if (!q.length) { ol.appendChild(el("li", "muted", "No open tasks.")); return; }
    q.forEach(it => {
      const li = el("li"); const main = el("div");
      main.append(taskLink(it, "qt"), el("span", "muted", it.id + " · " + agentName(ownerKey(it))));
      li.append(main, pill(laneStatus(it.lane)));
      ol.appendChild(li);
    });
  }

  function renderActivity() {
    const ol = $("aList"); ol.replaceChildren();
    const sel = $("aFilter").value;
    const items = activity({ issues: list(overview).filter(i => sel === "all" || ownerKey(i) === sel) }, 8);
    if (!overview) { ol.appendChild(el("li", "muted", "Loading…")); return; }
    if (!items.length) { ol.appendChild(el("li", "muted", "No recent activity.")); return; }
    items.forEach(it => {
      const li = el("li"); li.dataset.s = laneStatus(it.lane);
      const a = AGENTS.find(x => x.key === ownerKey(it));
      const badge = el("span", "badge sm"); badge.dataset.ag = a.key; badge.appendChild(icon(a.glyph));
      const txt = el("div");
      txt.append(el("b", null, a.name), taskLink(it, "at"), el("span", "muted", (it.status || "") + " · " + it.id));
      li.append(el("time", "mono", fmtTime(it.updatedAt)), badge, txt);
      ol.appendChild(li);
    });
  }

  function renderPerf() {
    const host = $("perf"); host.replaceChildren();
    AGENTS.forEach(a => {
      const s = agentStats(overview, a.key);
      const col = el("div", "pcol s-" + s.status); col.dataset.ag = a.key;
      const bar = el("div", "pbar"); const fill = el("i"); fill.style.height = Math.max(3, s.percent) + "%"; bar.appendChild(fill);
      col.append(bar, el("span", null, a.name), el("b", "mono", s.percent + "%"));
      host.appendChild(col);
    });
  }

  function render() { renderStatus(); renderTree(); renderQueue(); renderActivity(); renderPerf(); }

  async function load() {
    $("refresh").disabled = true;
    try {
      overview = await post({ action: "overview" });
      $("msg").hidden = !overview.hasNextPage;
      $("msg").textContent = overview.hasNextPage ? "Showing the latest 250 issues; older ones are not counted." : "";
      $("fresh").textContent = "Linear snapshot · " + fmtTime(overview.fetchedAt, true);
      $("fresh").className = "fresh ok";
    } catch (e) {
      $("msg").hidden = false;
      $("msg").textContent = e.message + (overview ? " Showing the last data received." : "");
      $("fresh").textContent = overview ? "Stale · " + fmtTime(overview.fetchedAt, true) : "Not loaded";
      $("fresh").className = "fresh warn";
    } finally { $("refresh").disabled = false; }
    render();
  }

  function tick() {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    $("clock").textContent = d.getUTCFullYear() + "." + p(d.getUTCMonth() + 1) + "." + p(d.getUTCDate()) + "  " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + " UTC";
  }

  function start() {
    const f = $("aFilter");
    AGENTS.forEach(a => { const o = el("option", null, a.name); o.value = a.key; f.appendChild(o); });
    f.onchange = renderActivity;
    $("refresh").onclick = load;
    window.addEventListener("resize", () => requestAnimationFrame(drawLinks));
    tick(); setInterval(tick, 15000);
    render(); load();
    setInterval(() => { if (!document.hidden) load(); }, 60000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})(typeof window !== "undefined" ? window : globalThis);
