// Workflow flow chart for the open workspace thread. A VIEW only: it reads the messages the page already fetched
// (get_thread) and the operation the page is running (the "acp:op" event from ops-ui.js), and draws them as a
// chart: your question -> safety rules check -> each AI's answer -> reviewing each other -> final answer, with the
// web reads, refusals and cost at every step. Tapping a node shows what happened there.
// It makes no requests of its own and changes nothing the page sends. All text is set with textContent.
(function (root) {
  "use strict";
  // Same markers as api/_lib/workspace-rules.js and api/_lib/workspace-roundtable.js (checked by test/flow-view.test.ts).
  const REFUSAL_MARK = "[Rules gate: refused]", STOP_MARK = "[Stopped by the owner]";
  const CRITIQUE_MARK = "[Roundtable round 2: critique and revised answer]", SYNTHESIS_MARK = "[Roundtable final answer]";
  // A second AI's quick check of one answer (AI + checker mode) is drawn with the reviews.
  const CHECK_MARK = "[Checked by a second AI]";
  const FAILED_PREFIX = "(The AI provider failed";
  const NAMES = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity" };
  const STATE_WORDS = { done: "Done", working: "Working", waiting: "Waiting", refused: "Refused", failed: "Failed", stopped: "Stopped", passed: "Passed" };
  const AUDIT = /\n\nWeb activity \(audit, times UTC, total \$([\d.]+)\):\n((?:- [^\n]*(?:\n|$))+)\s*$/;

  const num = (v) => { const n = Number(v); return isFinite(n) && n > 0 ? n : 0; };
  const nameOf = (m) => NAMES[m] || "AI";

  /** Splits the web audit written under a reply from the reply itself. */
  function splitAudit(content) {
    const text = String(content || "");
    const m = text.match(AUDIT);
    if (!m) return { text, web: [] };
    const web = m[2].split("\n").filter(Boolean).map((line) => {
      const p = line.match(/^- (\d\d:\d\d:\d\d) ([a-z_ ]+): (.*?)(?: \(\$([\d.]+)\))?$/);
      return p ? { at: p[1], kind: p[2], target: p[3], usd: num(p[4]) } : { at: "", kind: "web", target: line.slice(2), usd: 0 };
    });
    return { text: text.slice(0, m.index), web };
  }

  /** What a saved refusal or stop notice says: where it happened and why. */
  function notice(content) {
    const c = String(content || "");
    if (c.startsWith(STOP_MARK)) return { where: "stop", reason: c.slice(STOP_MARK.length).trim() || "Stopped by the owner." };
    if (!c.startsWith(REFUSAL_MARK)) return null;
    const reason = (c.match(/\nReason: ([^\n]*?)\.?\n/) || [])[1] || "A safety rule";
    const tool = c.match(/A tool call \(([^)\n]*)\) was blocked/);
    const where = /Your message was not sent/.test(c) ? "request" : /reply was withheld/.test(c) ? "reply" : tool ? "tool" : "other";
    return { where, reason, tool: tool ? tool[1] : null };
  }

  const kindOf = (m) => {
    if (m.role !== "assistant") return "user";
    const c = String(m.content || "");
    if (c.startsWith(REFUSAL_MARK) || c.startsWith(STOP_MARK)) return "notice";
    if (c.startsWith(SYNTHESIS_MARK)) return "synthesis";
    if (c.startsWith(CRITIQUE_MARK) || c.startsWith(CHECK_MARK)) return "critique";
    if (c.startsWith(FAILED_PREFIX)) return "failed";
    return "answer";
  };
  const bodyOf = (c) => String(c).replace(/^\[(Roundtable|Checked by)[^\]\n]*\]\n?/, "").trim();

  /**
   * Groups a thread's messages into questions ("turns"): the owner's message and every AI message after it.
   * A message refused by the rules gate is never saved, so its refusal notice starts a turn of its own.
   */
  function turnsOf(messages) {
    const turns = [];
    let cur = null;
    for (const m of Array.isArray(messages) ? messages : []) {
      if (!m || typeof m !== "object") continue;
      const k = kindOf(m), n = k === "notice" ? notice(m.content) : null;
      if (k === "user" || (n && n.where === "request")) { cur = { question: k === "user" ? m : null, refusal: n, replies: [] }; turns.push(cur); continue; }
      if (!cur) { cur = { question: null, refusal: null, replies: [] }; turns.push(cur); }
      cur.replies.push(m);
    }
    return turns;
  }

  function aiNode(m, kind, stage) {
    const { text, web } = splitAudit(m.content);
    const n = kind === "notice" ? notice(m.content) : null;
    const state = kind === "failed" ? "failed" : n ? (n.where === "stop" ? "stopped" : "refused") : "done";
    return {
      id: m.id || "", type: "ai", model: m.model || null, stage, state,
      title: nameOf(m.model), text: n ? "" : bodyOf(text), reason: n ? n.reason : "", web,
      tokensIn: num(m.input_tokens), tokensOut: num(m.output_tokens), usd: num(m.cost_usd), at: m.created_at || "",
    };
  }

  /**
   * The chart for one question. `live` is the operation running now (from ops-ui.js) or null:
   * { step: "start"|"critique"|"synthesize"|undefined, roundtable, units: [...], phase, usd, fresh }.
   * `fresh` marks a new question still on its way, so the chart shows it before the server has saved anything.
   */
  function buildFlow(turn, live) {
    const t = turn || { question: null, refusal: null, replies: [] };
    const stages = [[], [], []], blocked = [], notes = [];
    let stage = 0;
    for (const m of t.replies) {
      const k = kindOf(m);
      if (k === "synthesis") stage = 2; else if (k === "critique") stage = Math.max(stage, 1);
      const n = k === "notice" ? notice(m.content) : null;
      if (n && n.where === "tool") { blocked.push({ tool: n.tool, reason: n.reason, at: m.created_at || "" }); continue; }
      if (n && !m.model) { notes.push(aiNode(m, k, stage)); continue; }
      stages[stage].push(aiNode(m, k, stage));
    }
    const lv = live || null;
    const roundtable = stages[1].length > 0 || stages[2].length > 0 || Boolean(lv && lv.roundtable);
    // Nodes the running operation is still waiting on.
    if (lv) {
      const units = (lv.units || []).filter((u) => NAMES[u]);
      const pend = (i, ms, state) => ms.forEach((u) => { if (!stages[i].some((x) => x.model === u)) stages[i].push({ type: "ai", model: u, stage: i, state, title: nameOf(u), text: "", web: [], usd: 0, tokensIn: 0, tokensOut: 0, reason: "", id: "" }); });
      const answered = stages[0].filter((x) => x.state === "done").map((x) => x.model);
      if (!lv.step || lv.step === "start") pend(0, units, "working");
      if (lv.step === "critique") pend(1, answered, "working");
      if (lv.step === "synthesize" && !stages[2].length) stages[2].push({ type: "ai", model: null, stage: 2, state: "working", title: "Lead AI", text: "", web: [], usd: 0, tokensIn: 0, tokensOut: 0, reason: "", id: "" });
      if (roundtable && (!lv.step || lv.step === "start")) pend(1, units, "waiting");
      if (roundtable && lv.step !== "synthesize" && !stages[2].length) stages[2].push({ type: "ai", model: null, stage: 2, state: "waiting", title: "Lead AI", text: "", web: [], usd: 0, tokensIn: 0, tokensOut: 0, reason: "", id: "" });
    }
    const all = [...stages[0], ...stages[1], ...stages[2], ...notes];
    const web = all.flatMap((x) => x.web.map((w) => ({ ...w, by: x.title })));
    const usd = all.reduce((n, x) => n + x.usd, 0);
    const q = t.question;
    const question = {
      type: "question", title: "Your question",
      state: q || (lv && lv.fresh) ? "done" : t.refusal ? "refused" : "waiting",
      text: q ? splitAudit(q.content).text : t.refusal ? "This message was refused before it was saved, so its text isn't kept." : lv && lv.fresh ? "Sending…" : "",
      at: q ? q.created_at || "" : "",
    };
    const gate = {
      type: "gate", title: "Safety rules check",
      state: t.refusal ? "refused" : t.replies.length || (lv && !lv.fresh) ? "passed" : lv && lv.fresh ? "working" : "waiting",
      reason: t.refusal ? t.refusal.reason : "",
      text: t.refusal ? "Your message was not sent to any AI. The workspace's own rules refused it; no AI decided this."
        : "Every message, tool call and reply is checked against the workspace's safety rules before it is sent, run or shown.",
      blocked,
    };
    const multi = stages[0].length > 1;
    const labels = roundtable
      ? ["Step 1 of 3 · First answers", "Step 2 of 3 · Reviewing each other", "Step 3 of 3 · Final answer"]
      : [multi ? "Answers side by side" : "Answer", "", ""];
    const rows = roundtable ? labels.map((label, i) => ({ label, nodes: stages[i] })).filter((r) => r.nodes.length)
      : t.refusal && !stages[0].length ? [] : [{ label: labels[0], nodes: stages[0] }];
    const tools = web.length || blocked.length ? { type: "tools", title: "Web and tool calls", state: blocked.length ? "refused" : "done", web, blocked } : null;
    const working = all.find((x) => x.state === "working");
    const current = lv ? (lv.phase || "Working") : t.refusal ? "Refused by the safety rules" : working ? "Working" : all.length ? "Finished" : "Waiting for an AI";
    return { question, gate, rows, tools, notes, usd: usd + (lv && lv.usd > usd ? lv.usd - usd : 0), current, roundtable, live: Boolean(lv) };
  }

  const money = (n) => "$" + (n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(n >= 1 ? 2 : 3));
  const core = { turnsOf, buildFlow, splitAudit, notice, kindOf, money, STATE_WORDS, MARKS: { REFUSAL_MARK, STOP_MARK, CRITIQUE_MARK, SYNTHESIS_MARK } };
  root.ACPFlowCore = core;
  if (typeof document === "undefined") return;

  // ---- Drawing ------------------------------------------------------------------------------------------
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const NS = "http://www.w3.org/2000/svg";
  // State icons, so a state never depends on colour: check, pulse, clock, cross, bar.
  const ICONS = { done: "M5 12l5 5 9-10", passed: "M5 12l5 5 9-10", working: "M3 12h4l2-5 4 10 2-5h6", waiting: "M12 6v6l4 2M12 3a9 9 0 1 0 .01 0", refused: "M6 6l12 12M18 6L6 18", failed: "M6 6l12 12M18 6L6 18", stopped: "M7 7h10v10H7z" };
  function icon(state) {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", "18"); s.setAttribute("height", "18"); s.setAttribute("aria-hidden", "true"); s.setAttribute("class", "fv-icon");
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", ICONS[state] || ICONS.waiting); p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor"); p.setAttribute("stroke-width", "2.5"); p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
    s.append(p); return s;
  }
  const ops = () => root.ACPOpsCore || null;

  let box = null, sheet = null, messages = [], thread = null, live = null, pick = null, view = "chat";

  function nodeButton(n, wide) {
    const b = el("button", "fv-node fv-" + n.type + (wide ? " fv-wide" : ""));
    b.type = "button"; b.dataset.state = n.state;
    if (n.model) b.dataset.model = n.model;
    const head = el("span", "fv-head");
    if (n.type === "ai" && ops() && ops().insignia) head.append(ops().insignia(n.model || "none", 30));
    else head.append(el("span", "fv-shape fv-shape-" + n.type));
    head.append(el("span", "fv-title", n.title));
    const st = el("span", "fv-state"); st.append(icon(n.state), document.createTextNode(STATE_WORDS[n.state] || n.state));
    b.append(head, st);
    const meta = [];
    if (n.usd > 0) meta.push(money(n.usd));
    if (n.web && n.web.length) meta.push(n.web.length + " web " + (n.web.length === 1 ? "call" : "calls"));
    if (n.blocked && n.blocked.length) meta.push(n.blocked.length + " blocked");
    if (n.reason) meta.push(n.reason);
    if (meta.length) b.append(el("span", "fv-meta", meta.join(" · ")));
    b.setAttribute("aria-label", n.title + ": " + (STATE_WORDS[n.state] || n.state) + (meta.length ? ". " + meta.join(", ") : "") + ". Show details.");
    b.addEventListener("click", () => openSheet(n, b));
    return b;
  }
  function wire(state) { const w = el("div", "fv-wire"); w.dataset.state = state; w.setAttribute("aria-hidden", "true"); return w; }
  const rowState = (nodes) => nodes.some((x) => x.state === "working") ? "working" : nodes.length && nodes.every((x) => x.state === "waiting") ? "waiting" : "done";

  function render() {
    if (!box) return;
    const turns = turnsOf(messages);
    const fresh = live && (!live.step || live.step === "start");
    const list = fresh ? [...turns, { question: null, refusal: null, replies: [] }] : turns;
    if (pick == null || pick >= list.length || live) pick = list.length - 1;
    const kids = [];
    if (!thread) { box.replaceChildren(el("p", "empty", "Open a thread to see its workflow.")); return; }
    if (!list.length) { box.replaceChildren(el("p", "empty", "No questions in this thread yet. Send one and watch it flow through here.")); return; }
    const isLast = pick === list.length - 1;
    const f = buildFlow(list[pick], isLast && live ? { ...live, fresh: fresh && isLast } : null);
    // Status strip: current step and cost, readable at a glance.
    const strip = el("div", "fv-strip"); strip.dataset.state = f.live ? "working" : "idle";
    strip.append(el("span", "fv-now", f.live ? "Now: " + f.current : f.current), el("span", "fv-cost", money(f.usd) + (f.live ? " so far" : " for this question")));
    kids.push(strip);
    if (list.length > 1) {
      const nav = el("div", "fv-nav");
      const prev = el("button", "btn ghost", "◀ Earlier"), next = el("button", "btn ghost", "Later ▶");
      prev.type = next.type = "button"; prev.disabled = pick === 0; next.disabled = isLast;
      prev.addEventListener("click", () => { pick--; render(); });
      next.addEventListener("click", () => { pick++; render(); });
      nav.append(prev, el("span", "fv-count", "Question " + (pick + 1) + " of " + list.length), next);
      kids.push(nav);
    }
    const chart = el("ol", "fv-chart");
    chart.setAttribute("aria-label", "Workflow for question " + (pick + 1));
    const step = (label, nodes, wide, state) => {
      const li = el("li", "fv-step");
      if (chart.children.length) li.append(wire(state || rowState(nodes)));
      if (label) li.append(el("div", "fv-label", label));
      const row = el("div", "fv-row" + (nodes.length > 1 ? " fv-many" : ""));
      nodes.forEach((n) => row.append(nodeButton(n, wide)));
      li.append(row); chart.append(li);
    };
    step("", [f.question], true, "done");
    step("", [f.gate], true, f.gate.state === "working" ? "working" : "done");
    f.rows.forEach((r, i) => {
      step(r.label, r.nodes.length ? r.nodes : [{ type: "ai", model: thread.model, state: "waiting", title: NAMES[thread.model] || "AI", text: "", web: [], usd: 0, reason: "" }], r.nodes.length === 1);
      if (i === 0 && f.tools) step("", [f.tools], true, "done");
    });
    if (!f.rows.length && f.tools) step("", [f.tools], true, "done");
    f.notes.forEach((n) => step("", [n], true, "done"));
    kids.push(chart);
    box.replaceChildren(...kids);
  }

  // ---- Detail sheet -------------------------------------------------------------------------------------
  let opener = null;
  function openSheet(n, from) {
    opener = from;
    const body = sheet.querySelector(".fv-body"); body.replaceChildren();
    sheet.querySelector(".fv-sheet-title").textContent = n.title + " · " + (STATE_WORDS[n.state] || n.state);
    const fact = (k, v) => { if (v === "" || v == null) return; const p = el("p", "fv-fact"); p.append(el("b", "", k + ": "), document.createTextNode(String(v))); body.append(p); };
    if (n.type === "ai") fact("Step", ["First answer", "Reviewing the others and revising", "Final answer"][n.stage] || "Answer");
    if (n.reason) fact(n.state === "stopped" ? "Why it stopped" : "Why it was refused", n.reason);
    if (n.usd > 0 || n.tokensIn || n.tokensOut) fact("Cost", money(n.usd || 0) + (n.tokensIn || n.tokensOut ? " (" + (n.tokensIn || 0).toLocaleString() + " tokens in, " + (n.tokensOut || 0).toLocaleString() + " out)" : ""));
    if (n.at) { const d = new Date(n.at); if (!isNaN(d)) fact("Time", d.toLocaleString()); }
    if (n.state === "working") fact("Status", "This step is running now. Its answer appears here when it arrives.");
    if (n.state === "waiting") fact("Status", "This step hasn't started yet.");
    if (n.text) { body.append(el("h4", "", n.type === "question" ? "What you asked" : n.type === "gate" ? "What this step does" : "What it said")); body.append(el("pre", "fv-text", n.text)); }
    if (n.web && n.web.length) {
      body.append(el("h4", "", "Web reads and searches"));
      const ul = el("ul", "fv-list");
      n.web.forEach((w) => ul.append(el("li", "", (w.at ? w.at + " UTC · " : "") + (w.by ? w.by + " · " : "") + w.kind + ": " + w.target + (w.usd ? " (" + money(w.usd) + ")" : ""))));
      body.append(ul);
    }
    if (n.blocked && n.blocked.length) {
      body.append(el("h4", "", "Tool calls the safety rules blocked"));
      const ul = el("ul", "fv-list");
      n.blocked.forEach((x) => ul.append(el("li", "", (x.tool || "A tool") + ": " + x.reason)));
      body.append(ul);
    }
    if (typeof sheet.showModal === "function") sheet.showModal(); else sheet.setAttribute("open", "");
    sheet.querySelector(".fv-close").focus();
  }
  function closeSheet() { if (sheet.open && typeof sheet.close === "function") sheet.close(); else sheet.removeAttribute("open"); }

  // ---- Wiring into the workspace page -------------------------------------------------------------------
  function setView(v) {
    view = v;
    const chat = document.getElementById("mList");
    if (chat) chat.hidden = v === "flow";
    box.hidden = v !== "flow";
    for (const b of document.querySelectorAll(".fv-toggle button")) b.setAttribute("aria-pressed", String(b.dataset.view === v));
    try { root.localStorage.setItem("acp.view", v); } catch (e) { /* per-viewer convenience only */ }
    if (v === "flow") render();
  }
  function start() {
    const chat = document.getElementById("mList"), head = document.getElementById("cH");
    if (!chat || !head) return;
    box = el("div", "fv"); box.id = "fList"; box.hidden = true; box.setAttribute("aria-live", "polite");
    chat.after(box);
    const tg = el("div", "fv-toggle"); tg.setAttribute("role", "group"); tg.setAttribute("aria-label", "Show the thread as");
    [["chat", "Chat"], ["flow", "Flow chart"]].forEach(([v, label]) => {
      const b = el("button", "", label); b.type = "button"; b.dataset.view = v;
      b.addEventListener("click", () => setView(v)); tg.append(b);
    });
    head.after(tg);
    sheet = el("dialog", "fv-sheet"); sheet.setAttribute("aria-labelledby", "fvSheetTitle");
    const top = el("div", "fv-sheet-top"), title = el("h3", "fv-sheet-title"); title.id = "fvSheetTitle";
    const close = el("button", "btn fv-close", "Close"); close.type = "button";
    close.addEventListener("click", closeSheet);
    sheet.addEventListener("close", () => { if (opener && opener.isConnected) opener.focus(); });
    sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });
    top.append(title, close); sheet.append(top, el("div", "fv-body"));
    document.body.append(sheet);
    let saved = "chat";
    try { saved = root.localStorage.getItem("acp.view") || "chat"; } catch (e) { saved = "chat"; }
    setView(saved === "flow" ? "flow" : "chat");
    root.addEventListener("acp:op", (e) => { live = e.detail || null; if (view === "flow") render(); });
  }
  // The workspace calls this each time it (re)loads the open thread.
  root.ACPFlow = {
    update(msgs, th) {
      if (!th || !thread || th.id !== thread.id) pick = null;
      messages = Array.isArray(msgs) ? msgs : []; thread = th || null;
      if (box && view === "flow") render();
    },
    clear() { messages = []; thread = null; pick = null; if (box) render(); },
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})(typeof window !== "undefined" ? window : globalThis);
