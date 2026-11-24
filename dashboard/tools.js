// Tools page: connectors the owner adds by address and look-up tools he builds, from /api/workspace.
// Every check happens on the server (api/_lib/workspace-connectors.js); this page only collects the answers,
// shows the plain-language review, and sends the confirmation. Rendered with textContent only, never as HTML.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  let password = "";
  let projects = [];

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
    if (!r.ok) {
      const e = new Error(typeof j.error === "string" ? j.error : "Something went wrong (" + r.status + ").");
      e.problems = Array.isArray(j.problems) ? j.problems : [];
      throw e;
    }
    return j;
  }
  function say(text, cls) { const n = $("pageMsg"); n.hidden = !text; n.className = "msg" + (cls ? " " + cls : ""); n.textContent = text || ""; }
  function showError(out, e) {
    out.replaceChildren(el("p", "msg err", e.message));
    if (e.problems && e.problems.length) { const ul = el("ul", "problems"); for (const p of e.problems) ul.append(el("li", null, p)); out.append(ul); }
  }
  function summaryList(items) {
    const dl = el("dl", "sum");
    for (const s of items) dl.append(el("dt", null, s.title), el("dd", null, s.text));
    return dl;
  }
  function fillScope(sel) {
    sel.replaceChildren(el("option", null, "Every project"));
    sel.options[0].value = "";
    for (const p of projects) { const o = el("option", null, "Only the project " + p.name); o.value = p.id; sel.append(o); }
  }

  async function load() {
    const o = await post("tools_overview");
    projects = o.projects || [];
    fillScope($("mScope")); fillScope($("hScope"));
    const list = $("connList");
    list.replaceChildren();
    if (o.setupNeeded) list.append(el("p", "msg warn", "One setup step is still to do before you can add your own: the connectors table in the workspace database. Claude can do it once you say yes."));
    for (const s of o.fromVercel || []) {
      const c = el("div", "conn");
      const top = el("div", "top");
      top.append(el("strong", null, s.name), el("span", "chip on", "On"), el("span", "note", "Set in Vercel (ACP_MCP_SERVERS): " + s.host + " · tools: " + s.tools.join(", ")));
      c.append(top);
      list.append(c);
    }
    for (const r of o.connectors || []) {
      const c = el("div", "conn");
      c.dataset.on = String(r.enabled);
      const top = el("div", "top");
      top.append(el("strong", null, r.name), el("span", "chip " + (r.enabled ? "on" : "off"), r.enabled ? "On" : "Off"),
        el("span", "note", (r.kind === "http" ? "Look-up tool" : "Connector") + " · " + r.host));
      const toggle = el("button", "btn ghost", r.enabled ? "Turn off" : "Turn on");
      toggle.type = "button";
      toggle.addEventListener("click", guard(async () => { await post("connector_set_enabled", { id: r.id, enabled: !r.enabled }); await load(); }));
      const del = el("button", "btn ghost", "Delete");
      del.type = "button";
      del.addEventListener("click", guard(async () => {
        if (!window.confirm("Delete " + r.name + "? The AIs stop using it straight away.")) return;
        await post("connector_delete", { id: r.id }); await load();
      }));
      top.append(el("span", "grow"), toggle, del);
      const more = el("details");
      more.append(el("summary", "note", "What it can reach"), summaryList(r.summary || []));
      c.append(top, more);
      list.append(c);
    }
    if (!list.children.length) list.append(el("p", "empty", "Nothing added yet. Add a connector or build a tool below."));
  }
  function guard(fn) {
    return async (ev) => {
      if (ev && ev.preventDefault) ev.preventDefault();
      say("");
      try { await fn(ev); } catch (e) { say(e.message, "err"); }
    };
  }

  // Shows the review and a Confirm button; saving sends the confirmation code for exactly what was shown.
  function review(out, kind, spec, preview) {
    const box = el("div", "review");
    box.append(el("strong", null, "Check this before it turns on"), summaryList(preview.summary));
    const row = el("div", "row");
    const ok = el("button", "btn", "Confirm and turn on");
    ok.type = "button";
    const no = el("button", "btn ghost", "Change something");
    no.type = "button";
    ok.addEventListener("click", async () => {
      ok.disabled = true;
      try {
        await post("connector_save", { kind, spec, confirm: preview.confirm });
        out.replaceChildren(el("p", "msg", spec.name + " is on. The AIs can use it in their next reply."));
        await load();
      } catch (e) { ok.disabled = false; showError(out, e); }
    });
    no.addEventListener("click", () => out.replaceChildren());
    row.append(ok, no);
    box.append(row);
    out.replaceChildren(box);
  }
  const scope = (sel) => sel.value || null;

  // --- Connector (MCP) ---
  let offered = [];
  function mSpec() {
    const tools = [...$("mPicks").querySelectorAll("input[type=checkbox]:checked")].map((b) => {
      const t = offered.find((x) => x.name === b.value);
      return { name: t.name, args: t.args };
    });
    return { name: $("mName").value.trim(), url: $("mUrl").value.trim(), tokenVar: $("mKey").value.trim() || null, projectId: scope($("mScope")), tools };
  }
  $("mCheck").addEventListener("click", async () => {
    const out = $("mOut"), picks = $("mPicks");
    out.replaceChildren(el("p", "note", "Asking the server what it offers…"));
    picks.hidden = true;
    try {
      const r = await post("connector_inspect", { url: $("mUrl").value.trim(), tokenVar: $("mKey").value.trim() || null });
      offered = r.tools;
      picks.replaceChildren(el("span", null, "Pick the tools the AIs may use:"));
      for (const t of offered) {
        const lab = el("label");
        const box = el("input"); box.type = "checkbox"; box.value = t.name; box.disabled = Boolean(t.blocked);
        const text = el("span");
        const args = Object.keys(t.args);
        text.append(el("strong", null, t.name), document.createTextNode(" " + (t.description || "")),
          el("span", "note", " · the AI can send: " + (args.length ? args.join(", ") : "nothing")));
        if (t.blocked) text.append(el("span", "why", " · Not allowed: " + t.blocked));
        lab.append(box, text);
        picks.append(lab);
      }
      const go = el("button", "btn", "Review it"); go.type = "button";
      go.addEventListener("click", async () => {
        const spec = mSpec();
        try { review(out, "mcp", spec, await post("connector_preview", { kind: "mcp", spec })); } catch (e) { showError(out, e); }
      });
      picks.append(go);
      picks.hidden = false;
      out.replaceChildren();
    } catch (e) { showError(out, e); }
  });

  // --- Look-up tool (HTTP) ---
  function addInput() {
    if ($("hInputs").children.length >= 6) return;
    const row = el("div", "inrow");
    const name = el("input"); name.placeholder = "city"; name.maxLength = 30; name.setAttribute("aria-label", "Input name");
    const type = el("select", "sel"); type.setAttribute("aria-label", "Input type");
    for (const [v, t] of [["string", "Text"], ["number", "Number"], ["boolean", "Yes/no"]]) { const o = el("option", null, t); o.value = v; type.append(o); }
    const req = el("label", "note"); const rb = el("input"); rb.type = "checkbox"; req.append(rb, document.createTextNode(" Required"));
    const del = el("button", "btn ghost", "Remove"); del.type = "button"; del.addEventListener("click", () => row.remove());
    const desc = el("input"); desc.placeholder = "What it means (optional)"; desc.maxLength = 200; desc.style.gridColumn = "1 / -1"; desc.setAttribute("aria-label", "Input meaning");
    row.append(name, type, req, del, desc);
    $("hInputs").append(row);
  }
  function hSpec() {
    const inputs = [...$("hInputs").children].map((r) => {
      const [name, type, req, , desc] = r.children;
      return { name: name.value.trim(), type: type.value, required: req.querySelector("input").checked, description: desc.value.trim() };
    }).filter((i) => i.name);
    return {
      name: $("hName").value.trim(), description: $("hDesc").value.trim(), url: $("hUrl").value.trim(), returns: $("hRet").value.trim(),
      tokenVar: $("hKey").value.trim() || null, projectId: scope($("hScope")), inputs,
    };
  }
  $("hAddInput").addEventListener("click", addInput);
  $("hForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const spec = hSpec(), out = $("hOut");
    try { review(out, "http", spec, await post("connector_preview", { kind: "http", spec })); } catch (e) { showError(out, e); }
  });


  const sw = window.ACPStopSwitch.mount($("stopSwitch"), { post });
  sw.refresh();
  load().catch((e) => say(e.message, "err"));
})();
