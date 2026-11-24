// Operations-room presentation layer (designed in Lovable, hand-ported). Presentation only:
//  1. Unit insignia: a flat avatar per AI, told apart by SHAPE as well as colour, plus sub-insignia for each AI's
//     specialist agents, derived from the parent's shape. Drawn from fixed shape data, never from page text.
//  2. The operation beacon: an unmissable "OPERATION IN PROGRESS" bar while an AI request is running (which units,
//     which briefing phase, elapsed time, cost so far), collapsing to "STANDING BY" the moment work stops.
// It watches the page's own requests to /api/workspace and /api/intake without changing them: fetch is wrapped,
// the same request goes out and the caller gets the very same response promise back.
(function (root) {
  "use strict";
  const NAMES = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", codex: "Codex" };
  // Paused by the owner; must match SUSPENDED_AGENTS in src/config.ts (checked by test/ops-ui.test.ts).
  const SUSPENDED = Object.freeze(["gemini"]);
  // Outer silhouettes on a 48x48 grid: hexagon, roundel, diamond, triangle, shield.
  const SHAPES = {
    claude: "M24 2 L43 13 L43 35 L24 46 L5 35 L5 13 Z",
    chatgpt: "M24 2 A22 22 0 1 1 23.99 2 Z",
    gemini: "M24 1 L47 24 L24 47 L1 24 Z",
    perplexity: "M24 3 L46 44 L2 44 Z",
    codex: "M6 4 H42 V26 C42 36 34 42 24 46 C14 42 6 36 6 26 Z",
    none: "M8 8 H40 V40 H8 Z",
  };
  // Inner glyphs: asterisk, ring, four-point star, chevron, </>.
  const GLYPHS = {
    claude: { d: "M24 14 V34 M15 19 L33 29 M33 19 L15 29" },
    chatgpt: { d: "M24 16 A8 8 0 1 1 23.99 16 Z" },
    gemini: { d: "M24 13 C25 21 27 23 35 24 C27 25 25 27 24 35 C23 27 21 25 13 24 C21 23 23 21 24 13 Z", fill: true },
    perplexity: { d: "M16 38 L24 24 L32 38" },
    codex: { d: "M18 17 L12 24 L18 31 M30 17 L36 24 L30 31" },
    none: { d: "M18 24 H30" },
  };
  // Each AI's specialist agents, named from its role in src/agents.ts (and Codex's reviewer role in the project rules).
  const SUB_UNITS = {
    claude: ["Builder", "Reviewer", "Security"],
    chatgpt: ["Coordinator", "Planner", "Writer"],
    gemini: ["Challenger", "Google specialist"],
    perplexity: ["Researcher", "Source checker"],
    codex: ["Coder", "Reviewer"],
  };
  const PHASES = {
    start: "Step 1 of 3 · First answers: each AI answers on its own",
    critique: "Step 2 of 3 · Reviewing each other: the AIs check each other's answers",
    synthesize: "Step 3 of 3 · Final answer: the lead AI writes one recommendation",
  };
  const keyOf = (k) => (Object.prototype.hasOwnProperty.call(SHAPES, k) ? k : "none");

  // What a request means for the beacon, or null when it isn't AI work worth showing.
  function describe(url, init) {
    const path = String(url || "").replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (!init || String(init.method || "GET").toUpperCase() !== "POST") return null;
    if (path === "/api/intake") return { phase: "Sending your command", units: [] };
    if (path !== "/api/workspace") return null;
    let body = null;
    try { body = JSON.parse(typeof init.body === "string" ? init.body : ""); } catch (e) { return null; }
    const a = body && body.action, args = (body && body.args) || {};
    const units = Array.isArray(args.models) ? args.models.filter((m) => typeof m === "string").map(keyOf) : [];
    if (a === "chat") return { phase: "Waiting for the reply", units, thread: true };
    if (a === "compare") return { phase: "Getting answers side by side", units };
    if (a === "roundtable" && PHASES[args.step]) return { phase: PHASES[args.step], units, step: args.step, roundtable: true };
    return null;
  }

  // Dollars this response reports spending (a roundtable reports its running total).
  function costOf(j) {
    if (!j || typeof j !== "object") return { usd: 0, total: false };
    if (typeof j.roundtableUsd === "number" && isFinite(j.roundtableUsd)) return { usd: j.roundtableUsd, total: true };
    const ms = [].concat(j.message || [], Array.isArray(j.messages) ? j.messages : []);
    const usd = ms.reduce((n, m) => n + (m && isFinite(Number(m.cost_usd)) ? Number(m.cost_usd) : 0), 0);
    return { usd, total: false };
  }

  const money = (n) => "$" + (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2));
  const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };

  const core = { NAMES, SUSPENDED, SHAPES, SUB_UNITS, PHASES, describe, costOf, money, clock, keyOf };
  root.ACPOpsCore = core;
  if (typeof document === "undefined" || typeof root.fetch !== "function") return;

  // ---- Insignia -------------------------------------------------------------------------------------------
  const NS = "http://www.w3.org/2000/svg";
  let hatchSeq = 0;
  function svgEl(tag, attrs) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
  // rank > 0 draws an agent sub-insignia: the parent's silhouette with a numeral and a rank bar instead of the glyph.
  function insignia(key, size, opts) {
    const k = keyOf(key), o = opts || {}, rank = o.rank || 0;
    const suspended = o.suspended != null ? o.suspended : SUSPENDED.includes(k);
    const s = svgEl("svg", { width: size, height: size, viewBox: "0 0 48 48", class: "ins", "data-ins": k, focusable: "false" });
    if (o.label) { s.setAttribute("role", "img"); s.setAttribute("aria-label", o.label); } else s.setAttribute("aria-hidden", "true");
    const colour = "var(--a-" + k + ")";
    let fill = colour;
    if (suspended) {
      const id = "ins-hatch-" + (++hatchSeq);
      const defs = svgEl("defs", {}), pat = svgEl("pattern", { id, width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
      pat.append(svgEl("rect", { width: 6, height: 6, fill: "var(--idle)" }), svgEl("rect", { width: 3, height: 6, fill: "var(--panel-2)" }));
      defs.append(pat); s.append(defs); fill = "url(#" + id + ")";
    }
    s.append(svgEl("path", { d: SHAPES[k], fill, stroke: suspended ? "var(--fg)" : "var(--bg)", "stroke-width": suspended ? 2.5 : 1.5 }));
    const ink = "var(--bg)", tri = k === "perplexity";
    if (rank) {
      const t = svgEl("text", { x: 24, y: tri ? 38 : 31, "text-anchor": "middle", "font-family": "var(--mono)", "font-weight": 700, "font-size": 20, fill: ink });
      t.textContent = String(rank);
      s.append(t, svgEl("rect", { x: 17, y: tri ? 41 : 34, width: 14, height: 3, fill: ink }));
    } else {
      const g = GLYPHS[k];
      s.append(svgEl("path", g.fill ? { d: g.d, fill: ink } : { d: g.d, fill: "none", stroke: ink, "stroke-width": 4, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    }
    return s;
  }

  function subUnits(key) {
    const k = keyOf(key), names = SUB_UNITS[k];
    if (!names) return null;
    const box = document.createElement("div"); box.className = "subunits";
    const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = "Helpers"; box.append(tag);
    names.forEach((n, i) => {
      const chip = document.createElement("span"); chip.className = "subunit";
      const txt = document.createElement("span"); txt.textContent = NAMES[k] + "-" + (i + 1);
      const sm = document.createElement("small"); sm.textContent = n; txt.append(sm);
      chip.append(insignia(k, 24, { rank: i + 1 }), txt); box.append(chip);
    });
    return box;
  }

  const has = (node) => node && node.querySelector(":scope > .ins");
  function prepend(node, key, size) { if (node && !has(node)) { node.prepend(insignia(key, size)); node.classList.add("has-ins"); } }
  // Adds insignia to whatever the page has rendered; safe to run again (it skips what is already decorated).
  function decorate(scope) {
    const q = (sel) => (scope.querySelectorAll ? scope.querySelectorAll(sel) : []);
    q(".agent[data-ag]").forEach((card) => {
      const k = card.dataset.ag;
      prepend(card.querySelector("h3"), k, 28);
      if (SUB_UNITS[k] && !card.querySelector(":scope > .subunits")) card.append(subUnits(k));
    });
    q(".seg button[data-ag]").forEach((b) => prepend(b, b.dataset.ag, 20));
    q(".list button[data-model] > span:first-child").forEach((s) => prepend(s, s.parentElement.dataset.model, 18));
    q("#cModel[data-model]").forEach((c) => { const old = c.querySelector(":scope > .ins"); if (old && old.dataset.ins !== keyOf(c.dataset.model)) old.remove(); prepend(c, c.dataset.model, 18); });
    q(".m.assistant[data-model] > .who").forEach((w) => prepend(w, w.parentElement.dataset.model, 18));
  }

  function insigniaKey() {
    const d = document.createElement("details"); d.className = "panel ins-key"; d.id = "insKey";
    const s = document.createElement("summary"); s.textContent = "AI avatar key"; d.append(s);
    const ul = document.createElement("ul");
    Object.keys(SUB_UNITS).forEach((k) => {
      const li = document.createElement("li");
      const t = document.createElement("span");
      t.textContent = NAMES[k] + (SUSPENDED.includes(k) ? " (suspended)" : "") + ": " + SUB_UNITS[k].map((n, i) => (i + 1) + " " + n).join(", ");
      li.append(insignia(k, 32), ...SUB_UNITS[k].map((_, i) => insignia(k, 20, { rank: i + 1 })), t); ul.append(li);
    });
    d.append(ul);
    return d;
  }

  // ---- Operation beacon -----------------------------------------------------------------------------------
  let beacon = null, live = null, inflight = 0, op = null, timer = null, holdTimer = null, last = null;
  function radar() {
    const s = svgEl("svg", { width: 40, height: 40, viewBox: "0 0 40 40", class: "ob-radar", "aria-hidden": "true", focusable: "false" });
    s.append(svgEl("circle", { cx: 20, cy: 20, r: 18, fill: "var(--panel-2)", stroke: "currentColor", "stroke-width": 2 }),
      svgEl("circle", { cx: 20, cy: 20, r: 11, fill: "none", stroke: "currentColor", "stroke-opacity": ".5" }),
      svgEl("path", { d: "M20 2 V38 M2 20 H38", stroke: "currentColor", "stroke-opacity": ".3" }));
    const g = svgEl("g", { class: "ob-sweep" });
    g.append(svgEl("path", { d: "M20 20 L20 2 A18 18 0 0 1 35.6 11 Z", fill: "currentColor", "fill-opacity": ".55" }));
    s.append(g);
    return s;
  }
  const span = (cls, text) => { const e = document.createElement("span"); e.className = cls; if (text != null) e.textContent = text; return e; };
  function threadModel() { const c = document.getElementById("cModel"); return c && c.dataset.model ? keyOf(c.dataset.model) : null; }

  function render() {
    if (!beacon) return;
    const working = !!op;
    beacon.dataset.state = working ? "working" : "idle";
    beacon.style.color = working ? "var(--amber)" : "";
    const grow = span("ob-grow"), head = span("ob-headline"), meta = span("ob-meta");
    head.append(span("ob-blink"), span("ob-title", working ? "WORKING" : "READY"));
    grow.append(head, meta);
    const kids = [radar(), grow];
    if (working) {
      const t = span("ob-time", clock(Date.now() - op.started)); t.setAttribute("aria-hidden", "true");
      meta.append(span("ob-phase", op.phase), t,
        span("ob-cost", op.usd > 0 ? money(op.usd) + " so far" : "cost: counting"));
      if (op.units.length) {
        const u = span("ob-units");
        u.setAttribute("aria-label", "Thinking: " + op.units.map((k) => NAMES[k] || "AI").join(", "));
        op.units.forEach((k) => { const w = span("ob-unit"); w.append(insignia(k, 26)); u.append(w); });
        kids.push(u);
      }
    } else {
      meta.append(span("ob-phase", last ? "Last job took " + clock(last.ms) + (last.usd > 0 ? " · " + money(last.usd) : "") + (last.error ? " · ended with an error" : "") : "Nothing running"));
    }
    beacon.replaceChildren(...kids);
    // Screen readers hear the state and phase when they change, not every tick of the clock.
    const say = working ? "Working. " + op.phase : "Ready. Nothing running.";
    if (live && live.textContent !== say) live.textContent = say;
  }
  function tick() { const t = beacon && beacon.querySelector(".ob-time"); if (t && op) t.textContent = clock(Date.now() - op.started); }
  function begin(d) {
    clearTimeout(holdTimer);
    let units = d.units.length ? d.units : (op && op.units.length ? op.units : []);
    if (!units.length && d.thread && threadModel()) units = [threadModel()];
    if (!op) op = { started: Date.now(), usd: 0, units };
    op.phase = d.phase; op.units = units;
    if (!timer) timer = setInterval(tick, 1000);
    render();
  }
  function settle(d, res) {
    inflight = Math.max(0, inflight - 1);
    if (!op) return;
    if (res && res.cost) op.usd = res.cost.total ? Math.max(op.usd, res.cost.usd) : op.usd + res.cost.usd;
    if (inflight > 0) return render();
    // A roundtable runs one request per step; keep the job open briefly between steps so it doesn't flicker.
    const between = d.roundtable && d.step !== "synthesize" && res && res.ok;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      if (inflight > 0 || !op) return;
      last = { ms: Date.now() - op.started, usd: op.usd, error: !(res && res.ok) };
      op = null; clearInterval(timer); timer = null; render();
    }, between ? 8000 : 0);
    render();
  }

  const origFetch = root.fetch;
  root.fetch = function (url, init) {
    const p = origFetch.apply(this, arguments);
    let d = null;
    try { d = describe(typeof url === "string" ? url : url && url.url, init); } catch (e) { d = null; }
    if (d) {
      inflight++; begin(d);
      p.then((r) => {
        let c = null;
        try { c = r.clone(); } catch (e) { c = null; }
        if (!c) return settle(d, { ok: r.ok });
        c.json().then((j) => settle(d, { ok: r.ok, cost: costOf(j) }), () => settle(d, { ok: r.ok }));
      }, () => settle(d, { ok: false }));
    }
    return p;
  };

  function start() {
    const wrap = document.querySelector(".wrap");
    if (wrap) {
      beacon = document.createElement("div");
      beacon.className = "ops-beacon"; beacon.id = "opsBeacon";
      live = document.createElement("span"); live.className = "ob-live"; live.setAttribute("role", "status");
      const bar = wrap.querySelector(".bar");
      if (bar) bar.after(beacon); else wrap.prepend(beacon);
      beacon.after(live);
      render();
      if (document.getElementById("roster") || document.getElementById("cRoster")) wrap.append(insigniaKey());
    }
    decorate(document);
    new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1 && !(n.classList && (n.classList.contains("ins") || n.closest(".ops-beacon,.ins-key")))) { decorate(n.parentElement || n); }
    }).observe(document.body, { childList: true, subtree: true });
    // The thread chip changes model without adding nodes.
    const chip = document.getElementById("cModel");
    if (chip) new MutationObserver(() => decorate(chip.parentElement)).observe(chip, { attributes: true, attributeFilter: ["data-model"] });
  }
  core.insignia = insignia;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})(typeof window !== "undefined" ? window : globalThis);
