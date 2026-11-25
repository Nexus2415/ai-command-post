// Workspace page (Phase 1 steps 2-3): projects, threads and the open conversation, from /api/workspace.
// Everything is rendered with textContent and never parsed as HTML, because messages are untrusted text.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const MODEL_NAMES = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity" };
  let projectId = null, threadId = null, busy = false, status = null, files = [], lastState = null, threadPrivate = null;
  // Images and PDFs uploaded to the open thread for the next message (ids from upload_file), up to 3.
  let uploads = [];
  // The owner's choice of extra AIs for a discussion (null: the default, one more).
  let picks = null;
  // Same markers as api/_lib/workspace-roundtable.js.
  const CRITIQUE_MARK = "[Roundtable round 2: critique and revised answer]", SYNTHESIS_MARK = "[Roundtable final answer]";
  const CHECK_MARK = "[Checked by a second AI]";
  const kindOf = (m) => m.role !== "assistant" ? "user" : m.content.startsWith(SYNTHESIS_MARK) ? "synthesis"
    : m.content.startsWith(CHECK_MARK) ? "check"
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

  // Project memory: the owner's notes, and facts the AIs saved from shared threads. A fact from a reply that used
  // the web, a tool or another thread waits here until the owner keeps it; no AI reads it before then.
  async function loadNotes() {
    const { notes } = await post("list_notes", { projectId });
    const list = $("nList"); list.replaceChildren();
    if (!notes.length) list.append(el("li", "empty", "No notes yet."));
    for (const n of notes) {
      const row = el("li", "nrow" + (n.pending ? " pending" : ""));
      const body = el("span", null, n.content);
      const tag = n.source === "ai"
        ? el("span", "note ntag", (n.pending ? "Waiting for you. " : "") + "Saved by " + (MODEL_NAMES[n.model] || "an AI"))
        : null;
      const actions = el("span", "row nact");
      const btn = (label, aria, fn) => {
        const b = el("button", null, label); b.type = "button"; b.setAttribute("aria-label", aria + ": " + n.content.slice(0, 40));
        b.addEventListener("click", guard(fn)); actions.append(b); return b;
      };
      if (n.pending) btn("Keep", "Keep this fact", async () => { await post("keep_note", { noteId: n.id }); await loadNotes(); });
      btn("Edit", "Edit note", async () => {
        const next = window.prompt("Edit this note", n.content);
        if (next == null || !next.trim() || next.trim() === n.content) return;
        await post("update_note", { noteId: n.id, content: next });
        await loadNotes();
      });
      btn("Delete", "Delete note", async () => { await post("delete_note", { noteId: n.id }); await loadNotes(); });
      row.append(body);
      if (tag) row.append(tag);
      row.append(actions);
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
    $("aPanel").hidden = true;
    $("mList").replaceChildren();
    $("welcome").hidden = false;
    if (window.ACPFlow) window.ACPFlow.clear();
  }

  async function openThread(id) {
    if (id !== threadId) { uploads = []; showFiles(); }
    threadId = id;
    const { thread, messages } = await post("get_thread", { threadId: id });
    $("welcome").hidden = true;
    setDrawer(false);
    $("cH").textContent = thread.title;
    const chip = $("cModel"); chip.hidden = false; chip.dataset.model = thread.model;
    chip.lastElementChild.textContent = MODEL_NAMES[thread.model] || thread.model;
    showPrivacy(thread.private);
    const list = $("mList"); list.replaceChildren();
    if (!messages.length) list.append(el("p", "empty", "No messages yet."));
    // Each question and the AI messages after it form one turn. A finished roundtable shows its concluded answer
    // first, with each AI's own answer and how they settled their disagreements folded underneath. Anything else
    // (one AI, side-by-side, a roundtable still under way) shows in order, with side-by-side answers in columns.
    const turns = [];
    for (const m of messages) { if (m.role !== "assistant" || !turns.length) turns.push([]); turns[turns.length - 1].push(m); }
    const nameOf = (m) => m.role === "assistant" ? (m.model ? MODEL_NAMES[m.model] || "AI" : m.content.startsWith("[Approval gate]") ? "Workspace" : "AI") : "You";
    const boxOf = (m, kind) => {
      const box = el("div", "m " + (m.role === "assistant" ? "assistant" : "user") + (kind === "synthesis" ? " synth" : ""));
      if (m.model) box.dataset.model = m.model;
      const name = nameOf(m);
      const body = m.content.replace(/^\[(Roundtable|Checked by)[^\]\n]*\]\n?/, "");
      if (kind === "check") box.classList.add("check");
      box.append(el("span", "who", kind === "critique" ? name + " · review and revised answer"
        : kind === "check" ? "Checked by " + name + (/^\W*disagree\b/i.test(body) ? " · disagrees" : " · agrees")
        : kind === "synthesis" ? "Concluded answer · agreed by the AIs, written by " + name : name));
      showContent(box, kind === "critique" || kind === "synthesis" || kind === "check" ? body : m.content);
      if (m.role === "assistant" && window.speechSynthesis) box.firstChild.append(speakButton(box));
      return box;
    };
    const rowOf = (ms, kind) => { const r = el("div", "cmp"); r.dataset.kind = kind; for (const m of ms) r.append(boxOf(m, kind)); return r; };
    const fold = (title, row) => { const d = el("details", "rt-fold"); d.append(el("summary", null, title), row); return d; };
    for (const turn of turns) {
      const head = turn[0].role === "user" ? [turn[0]] : [];
      const ai = turn.slice(head.length);
      for (const m of head) list.append(boxOf(m, "user"));
      const synth = ai.find((m) => kindOf(m) === "synthesis");
      if (synth) {
        const answers = ai.filter((m) => kindOf(m) === "answer"), reviews = ai.filter((m) => ["check", "critique"].includes(kindOf(m)));
        list.append(boxOf(synth, "synthesis"));
        if (answers.length) list.append(fold("Each AI's own answer (" + answers.map(nameOf).join(", ") + ")", rowOf(answers, "answer")));
        if (reviews.length) { const r = el("div", "cmp"); r.dataset.kind = "critique"; for (const m of reviews) r.append(boxOf(m, kindOf(m))); list.append(fold("How they settled their disagreements", r)); }
        for (const m of ai) if (!["synthesis", "answer", "critique", "check"].includes(kindOf(m))) list.append(boxOf(m, kindOf(m)));
        continue;
      }
      let row = null, rowKind = null;
      for (const m of ai) {
        const kind = kindOf(m);
        if (!row || rowKind !== kind) {
          row = el("div", "cmp"); rowKind = kind; row.dataset.kind = kind;
          if (kind === "critique") list.append(el("div", "round", "Step 2 of 3 · Settling disagreements"));
          list.append(row);
        }
        row.append(boxOf(m, kind));
      }
    }
    // Unwrap rows holding a single plain answer, so one-AI replies look like a normal chat.
    for (const r of list.querySelectorAll(".cmp")) if (r.children.length === 1 && (r.dataset.kind !== "critique") && !r.closest("details")) r.replaceWith(r.firstElementChild);
    lastState = roundState(messages);
    if (window.ACPFlow) window.ACPFlow.update(messages, thread);
    const sc = $("scroller"); sc.scrollTop = sc.scrollHeight;
    $("cForm").hidden = false;
    const ms = status && status.models[thread.model];
    $("cNote").textContent = ms && !ms.ready ? (MODEL_NAMES[thread.model] || "This AI") + " can't reply yet: " + ms.reason
      : "Ctrl+Enter to send.";
    $("cRetry").hidden = !(messages.length && messages[messages.length - 1].role === "user" && ms && ms.ready);
    // How each question is answered: the toggle on the question box, remembered per project while the page is open.
    // "1 AI" asks this thread's AI; "+ Checker" (the default) has the cheapest other AI check that answer and runs
    // the discussion only if it disagrees; "Discussion" asks this thread's AI plus the AIs ticked under "AIs".
    const box = $("cCompare");
    box.replaceChildren(box.firstElementChild);
    const others = ms && ms.ready && status ? Object.keys(MODEL_NAMES).filter((k) => k !== thread.model && status.models[k] && status.models[k].ready) : [];
    const chosen = picks ? others.filter((k) => picks.has(k)) : others.slice(0, 1);
    for (const k of others) {
      const input = el("input"); input.type = "checkbox"; input.value = k; input.checked = chosen.includes(k);
      input.addEventListener("change", () => {
        if (!box.querySelector("input:checked")) input.checked = true; // a discussion needs at least one more AI
        picks = new Set([...box.querySelectorAll("input:checked")].map((i) => i.value)); showMode();
      });
      const label = el("label"); label.append(input, document.createTextNode(MODEL_NAMES[k]));
      box.append(label);
    }
    box.hidden = !others.length;
    for (const r of document.querySelectorAll('#cMode input')) r.disabled = r.value !== "single" && !others.length;
    setMode(others.length ? savedMode() : "single", false);
    // A side-by-side answer (or a roundtable that stopped part way) can be taken through the remaining rounds.
    $("cDiscuss").hidden = !(lastState && lastState.answers >= 2 && !lastState.done);
    $("cDiscuss").textContent = lastState && lastState.critiques ? "Finish: write the agreed answer" : "Agree on one answer from these";
    await Promise.all([loadThreads(), loadStatus(), loadActions()]);
  }

  // Approval gate: actions an AI proposed in this thread. Pending ones get Approve and Reject; the last few decided
  // ones are listed with their outcome. Approve sends back the code of exactly what is shown here.
  const ACTION_STATUS = { done: "Done", failed: "Failed", rejected: "Rejected", expired: "Expired", running: "Running" };
  async function loadActions() {
    const panel = $("aPanel"), list = $("aList");
    if (!threadId) { panel.hidden = true; return; }
    let out;
    try { out = await post("list_actions", { threadId }); } catch { panel.hidden = true; return; }
    const pending = out.actions.filter((a) => a.status === "proposed");
    const recent = out.actions.filter((a) => a.status !== "proposed").slice(0, 3);
    list.replaceChildren();
    panel.hidden = !pending.length && !recent.length;
    $("aH").textContent = pending.length ? "Waiting for your approval (" + pending.length + ")" : "Recent actions";
    for (const a of [...pending, ...recent]) {
      const li = el("li", "acard"); li.dataset.status = a.status;
      li.append(el("span", "what", a.label + (a.status === "proposed" ? "" : " · " + (ACTION_STATUS[a.status] || a.status))));
      li.append(el("span", "note", a.where + " · proposed by " + (MODEL_NAMES[a.proposedBy] || "an AI") + " · " + when(a.createdAt)));
      li.append(el("pre", "", a.text));
      if (a.result) li.append(el("span", "note", a.result + (a.resultUrl ? " " + a.resultUrl : "")));
      if (a.status === "proposed") {
        const row = el("div", "row");
        const yes = el("button", "btn", "Approve"); yes.type = "button";
        const no = el("button", "btn reject", "Reject"); no.type = "button";
        yes.disabled = halted;
        yes.addEventListener("click", guard(async () => {
          if (!window.confirm("Approve this?\n\n" + a.label + "\n" + a.where + "\n\n" + a.text.slice(0, 600))) return;
          try { await post("decide_action", { id: a.id, decision: "approve", confirm: a.confirm }); }
          finally { await openThread(threadId); }
        }));
        no.addEventListener("click", guard(async () => {
          try { await post("decide_action", { id: a.id, decision: "reject" }); } finally { await openThread(threadId); }
        }));
        row.append(yes, no, el("span", "note", "Expires " + when(a.expiresAt)));
        li.append(row);
      }
      list.append(li);
    }
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
  // A light-model answer ends with this line (same as api/_lib/workspace-shared.js ROUTE_LABEL).
  const ROUTE_LINE = /\n*Answered by the light model \(smart routing\): ([^\n]*)/;
  // Attached files arrive folded into the message between markers; each shows as a collapsible block.
  const FILE_BLOCK = /<<<file: ([^\n]{1,120})>>>\n([\s\S]*?)\n<<<end of file>>>/g;
  function showContent(box, content) {
    const src = content.match(SOURCES_LINE);
    if (src) content = content.replace(SOURCES_LINE, "");
    const route = content.match(ROUTE_LINE);
    if (route) content = content.replace(ROUTE_LINE, "");
    showText(box, content);
    if (src) box.append(el("div", "drew", "Drew on: " + src[1]));
    if (route) box.append(el("div", "drew", "⚡ Light model: " + route[1]));
  }
  // Images and PDFs are named by a marker (same as api/_lib/workspace-files.js); each shows as the picture itself,
  // or a button that opens the PDF. Files are fetched from the server and shown through blob links, never as HTML.
  const ATTACHED = /<<<attached (image|PDF, \d+ pages?): ([^\n<>#]{1,120}) #([0-9a-f-]{36})>>>/g;
  const blobs = new Map();
  async function fileUrl(id) {
    if (!blobs.has(id)) {
      const { file } = await post("get_file", { threadId, fileId: id });
      const bin = atob(file.data), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      blobs.set(id, URL.createObjectURL(new Blob([bytes], { type: file.mime })));
    }
    return blobs.get(id);
  }
  function attachedBox(kind, name, id) {
    const d = el("div", "attached");
    if (kind === "image") {
      const img = el("img"); img.alt = name; img.loading = "lazy";
      d.append(img, el("span", "note", name));
      fileUrl(id).then((u) => { img.src = u; }, () => { img.replaceWith(el("span", "note", "(image no longer available)")); });
    } else {
      const b = el("button", "btn ghost", "Open PDF: " + name + " (" + kind.slice(5) + ")"); b.type = "button";
      b.addEventListener("click", () => fileUrl(id).then((u) => window.open(u, "_blank", "noopener"), (e) => say(e.message, "err")));
      d.append(b);
    }
    return d;
  }
  function showText(box, content) {
    let at = 0;
    const blocks = [
      ...[...content.matchAll(FILE_BLOCK)].map((f) => ({ at: f.index, len: f[0].length, node: () => { const d = el("details", "file"); d.append(el("summary", "", "File: " + f[1]), el("pre", "", f[2])); return d; } })),
      ...[...content.matchAll(ATTACHED)].map((f) => ({ at: f.index, len: f[0].length, node: () => attachedBox(f[1] === "image" ? "image" : f[1], f[2], f[3]) })),
    ].sort((a, b) => a.at - b.at);
    for (const f of blocks) {
      if (f.at < at) continue;
      const before = content.slice(at, f.at).trim();
      if (before) box.append(document.createTextNode(before));
      box.append(f.node());
      at = f.at + f.len;
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
    uploads.forEach((u, i) => {
      const chip = el("span", "chip", u.name + (u.pages ? " (PDF, " + u.pages + (u.pages === 1 ? " page)" : " pages)") : " (image)"));
      const x = el("button", "", "Remove"); x.type = "button"; x.setAttribute("aria-label", "Remove " + u.name);
      x.addEventListener("click", () => { uploads.splice(i, 1); showFiles(); });
      chip.append(x); row.append(chip);
    });
    syncMic();
    // What the files add to each reply, at the dearest AI's rates (Claude): an image ~0.3¢, a PDF page up to ~0.4¢.
    if (uploads.length) {
      const pages = uploads.reduce((n, u) => n + (u.pages || 0), 0), imgs = uploads.filter((u) => !u.pages).length;
      const cents = imgs * 0.35 + pages * 0.45;
      row.append(el("span", "note", "Adds up to about " + (cents < 1 ? cents.toFixed(1) : Math.ceil(cents)) + "¢ to each reply while these are the newest files in the thread."));
    }
  }
  // Images are shrunk here to at most 1568 px on the long side (what the AIs read anyway) and sent as JPEG, so a
  // phone photo uploads as a few hundred KB. GIFs are sent as they are. Nothing is kept in browser storage.
  const MAX_SIDE = 1568;
  async function shrink(file) {
    if (file.type === "image/gif") return file;
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error("Couldn't read " + file.name + "."))), "image/jpeg", 0.85));
  }
  async function base64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  async function upload(file) {
    if (!threadId) throw new Error("Open a thread first.");
    if (uploads.length >= 3) throw new Error("Attach at most 3 images or PDFs.");
    const pdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (pdf && file.size > 3000000) throw new Error(file.name + " is too big: PDFs up to 3 MB work.");
    if (!pdf && file.size > 25000000) throw new Error(file.name + " is too big.");
    const blob = pdf ? file : await shrink(file);
    if (!pdf && blob.size > 1500000) throw new Error(file.name + " is still over 1.5 MB after shrinking.");
    const name = file.name.replace(/[\u0000-\u001f<>#]/g, "_").slice(0, 120) || "file";
    const mime = pdf ? "application/pdf" : blob.type || file.type;
    say("Uploading " + name + "…", "warn");
    const { file: saved } = await post("upload_file", { threadId, name: pdf || mime === "image/gif" ? name : name.replace(/\.[a-z0-9]+$/i, "") + ".jpg", mime, data: await base64(blob) });
    uploads.push(saved);
    say("");
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
        if (/^image\//.test(file.type) || file.type === "application/pdf" || /\.pdf$/i.test(file.name)) { await upload(file); continue; }
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
    if (!text.trim() && !files.length && !uploads.length) return;
    const attachments = files.length ? files : undefined;
    const picked = uploads.length ? uploads.map((u) => u.id) : undefined;
    $("cSend").disabled = true;
    const ms = status && currentModel() && status.models[currentModel()];
    say(ms && ms.ready ? "Waiting for the reply…" : "");
    try {
      // With no AI ready the message is only saved; otherwise the server saves it and asks the thread's AI.
      const also = [...$("cCompare").querySelectorAll("input:checked")].map((i) => i.value);
      const how = mode();
      let failed = [];
      if (ms && ms.ready && how === "discuss" && also.length) {
        const ran = await roundtable(text, attachments, [currentModel(), ...also], picked);
        if (ran) { $("cText").value = ""; grow(); files = []; uploads = []; showFiles(); }
        return;
      }
      if (ms && ms.ready) await post("chat", { threadId, content: text, attachments, files: picked, routing: smart() }).catch(async (e) => { await openThread(threadId); throw e; });
      else await post("add_message", { threadId, content: text, attachments, files: picked });
      uploads = [];
      if (ms && ms.ready && how === "check") {
        $("cText").value = ""; grow(); files = []; showFiles();
        await openThread(threadId);
        await checkAnswer();
        return;
      }
      $("cText").value = ""; grow(); files = []; showFiles();
      say(failed.map((f) => (MODEL_NAMES[f.model] || f.model) + " didn't answer: " + f.error).join(" "), failed.length ? "err" : "");
      await openThread(threadId);
    } finally { $("cSend").disabled = halted; }
  }));
  $("cRetry").addEventListener("click", guard(async () => {
    say("Waiting for the reply…");
    await post("chat", { threadId, routing: smart() }).catch(async (e) => { await openThread(threadId); throw e; });
    say("");
    await openThread(threadId);
  }));
  // Roundtable mode: round 1 (each AI answers), round 2 (each critiques the others and revises), round 3 (the
  // lead writes one conclusion). One request per round; the server checks the budget before each one.
  const who = (list) => (list || []).map((f) => (MODEL_NAMES[f.model] || f.model) + " dropped out: " + f.error).join(" ");
  // AI + checker: a second AI checks the answer just given. If it disagrees, it gives its own answer and the two
  // settle the conflict through the usual review and conclusion rounds.
  async function checkAnswer() {
    say("Checking the answer with a second AI…", "warn");
    let c;
    try { c = await post("check", { threadId }); } catch (e) { say("The answer stands, but the check didn't run: " + e.message, "err"); return; }
    await openThread(threadId);
    const checker = MODEL_NAMES[c.checker] || c.checker;
    if (!c.disagrees) { say(checker + " checked it and agrees."); return; }
    say(checker + " disagrees, so it answers too and they settle it… (step 1 of 3)", "warn");
    try { await post("roundtable", { step: "join", threadId, model: c.checker }); } finally { await openThread(threadId); }
    await finishRoundtable([c.answeredBy, c.checker], 0, "");
  }
  // Smart routing: on by default (the cheap choice). Kept in memory for this page only, never in browser storage.
  const smart = () => $("cSmart").getAttribute("aria-pressed") === "true";
  $("cSmart").addEventListener("click", () => {
    const on = !smart();
    $("cSmart").setAttribute("aria-pressed", String(on));
    $("cSmart").title = on ? "Smart routing is on: short, simple questions go to a light model (Claude Haiku or GPT-5 nano), about 20 times cheaper. Anything harder still gets the full model. Click to always use the full model."
      : "Smart routing is off: every question goes to the full model. Click to send simple questions to a light model, about 20 times cheaper.";
    showMode();
  });
  const MODE_HINT = {
    single: "One AI answers. Cheapest: well under 1¢.",
    check: "One AI answers, a cheaper AI checks it: about 1¢. If they disagree, they discuss it (a few ¢).",
    discuss: "Each AI answers, they settle disagreements, then one agreed answer: a few ¢ (up to ~15¢ with 3 AIs, plus about 1¢ per web search).",
  };
  // Remembered per project while the page is open. Kept in memory only: this page never writes browser storage.
  const modes = new Map();
  const savedMode = () => modes.get(projectId) || "check";
  function mode() { const r = document.querySelector('#cMode input:checked'); return r ? r.value : "single"; }
  function showMode() {
    const how = mode();
    $("cOptsBtn").hidden = how !== "discuss";
    // Discussion always uses each AI's full model.
    $("cSmart").hidden = how === "discuss";
    if (how !== "discuss") setOpts(false);
    const n = $("cCompare").querySelectorAll("input:checked").length + 1;
    $("cOptsBtn").textContent = n + " AIs";
    const ms = status && threadId && currentModel() && status.models[currentModel()];
    if (ms && ms.ready) $("cNote").textContent = MODE_HINT[how] + (how !== "discuss" && smart() ? " ⚡ Simple questions: light model, ~20× cheaper." : "");
  }
  function setMode(v, remember) {
    for (const r of document.querySelectorAll('#cMode input')) r.checked = r.value === v;
    if (remember) modes.set(projectId, v);
    showMode();
  }
  for (const r of document.querySelectorAll('#cMode input')) r.addEventListener("change", () => setMode(r.value, true));
  async function roundtable(text, attachments, models, picked) {
    const est = await post("roundtable_estimate", { threadId, content: text, attachments, models, files: picked });
    if (!est.fits) throw new Error("Not sent: asking several AIs could cost up to " + money(est.estimate.total) + ". " + est.why);
    say("Step 1 of 3: each AI answers on its own…", "warn");
    const r1 = await post("roundtable", { step: "start", threadId, content: text, attachments, models, files: picked });
    await openThread(threadId);
    return finishRoundtable(models, r1.roundtableUsd, who(r1.failed));
  }
  async function finishRoundtable(models, soFar, dropped) {
    const notes = dropped ? [dropped] : [];
    const st = lastState || { critiques: 0 };
    if (!st.critiques) {
      say("Step 2 of 3: the AIs check each other's answers and settle disagreements… (" + money(soFar) + " so far)", "warn");
      try {
        const r2 = await post("roundtable", { step: "critique", threadId });
        soFar = r2.roundtableUsd; if (r2.failed && r2.failed.length) notes.push(who(r2.failed));
      } catch (e) { await openThread(threadId); throw e; }
      await openThread(threadId);
    }
    say("Step 3 of 3: writing the one agreed answer… (" + money(soFar) + " so far)", "warn");
    try {
      const r3 = await post("roundtable", { step: "synthesize", threadId, models });
      notes.push("Done. This answer cost " + money(r3.roundtableUsd) + ".");
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
    for (const b of $("aList").querySelectorAll(".btn:not(.reject)")) b.disabled = halted;
  }
  const stopSwitch = window.ACPStopSwitch.mount($("stopSwitch"), { post, onChange: setHalted });
  function currentModel() { return $("cModel").dataset.model || null; }
  // ---- Layout: the list drawer (phones), the More menu, the "Ask more AIs" options and the growing question box.
  const narrow = () => window.matchMedia("(max-width: 900px)").matches;
  function setDrawer(open) {
    const side = $("side");
    side.classList.toggle("open", open);
    $("scrim").hidden = !open;
    $("menuBtn").setAttribute("aria-expanded", String(open));
    if (open && narrow()) $("sideClose").focus();
  }
  $("menuBtn").addEventListener("click", () => setDrawer(!$("side").classList.contains("open")));
  $("sideClose").addEventListener("click", () => { setDrawer(false); $("menuBtn").focus(); });
  $("scrim").addEventListener("click", () => setDrawer(false));
  $("welcomeOpen").addEventListener("click", () => {
    if (narrow()) setDrawer(true);
    const first = $("side").querySelector(".list button"); if (first) first.focus();
  });
  function setMore(open) { $("morePanel").hidden = !open; $("moreBtn").setAttribute("aria-expanded", String(open)); }
  $("moreBtn").addEventListener("click", (e) => { e.stopPropagation(); setMore($("morePanel").hidden); });
  document.addEventListener("click", (e) => { if (!$("morePanel").hidden && !$("morePanel").contains(e.target)) setMore(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("morePanel").hidden) { setMore(false); $("moreBtn").focus(); }
    else if ($("side").classList.contains("open") && narrow()) { setDrawer(false); $("menuBtn").focus(); }
  });
  function setOpts(open) { $("cOpts").hidden = !open; $("cOptsBtn").setAttribute("aria-expanded", String(open)); }
  $("cOptsBtn").addEventListener("click", () => setOpts($("cOpts").hidden));
  // The flow chart's Chat / Flow chart switch lives in the More menu, out of the reading path.
  const moveToggle = () => { const t = document.querySelector(".bar .fv-toggle"); if (t) $("viewSlot").append(t); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", moveToggle); else moveToggle();
  const grow = () => { const t = $("cText"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.4) + "px"; syncMic(); };
  $("cText").addEventListener("input", grow);
  new MutationObserver(grow).observe($("cForm"), { attributes: true, attributeFilter: ["hidden"] });
  $("cText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("cForm").requestSubmit(); });

  // Voice. Talk: the browser turns speech into text in the question box (Chrome sends the audio to Google's speech
  // service, Safari to Apple's); you still check it and press send. Listen: an answer is read aloud by the device's
  // own voice. Both are free, nothing is recorded or stored here, and neither sends anything to the AIs by itself.
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  // The microphone takes the send button's place while the box is empty, as in other chat apps.
  function syncMic() {
    const mic = $("cMic");
    if (!Recognition) { mic.hidden = true; $("cSend").hidden = false; return; }
    const empty = !$("cText").value.trim() && !files.length && !uploads.length;
    mic.hidden = !(empty || rec);
    $("cSend").hidden = !mic.hidden;
  }
  $("cMic").addEventListener("click", () => {
    if (rec) { rec.stop(); return; }
    const before = $("cText").value.trim() ? $("cText").value.replace(/\s*$/, " ") : "";
    rec = new Recognition();
    rec.lang = navigator.language || "en-US"; rec.interimResults = true; rec.continuous = true;
    rec.onresult = (e) => { let t = ""; for (const r of e.results) t += r[0].transcript; $("cText").value = before + t.trimStart(); grow(); };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") say("The microphone is blocked. Allow it for this site in the browser's settings, then tap the microphone again.", "err");
      else if (e.error !== "aborted" && e.error !== "no-speech") say("Talking didn't work this time (" + e.error + "). Try again, or type.", "err");
    };
    rec.onend = () => {
      rec = null; $("cMic").classList.remove("on"); $("cMic").setAttribute("aria-pressed", "false");
      if ($("pageMsg").textContent.startsWith("Listening")) say("");
      syncMic(); $("cText").focus();
    };
    try { rec.start(); } catch (e) { rec = null; say("Talking isn't available right now. Type instead.", "err"); return; }
    $("cMic").classList.add("on"); $("cMic").setAttribute("aria-pressed", "true");
    say("Listening… tap the microphone again when you're done. Check the text, then send.", "warn");
  });
  // Read aloud: the answer's own text (not the name line or notes under it), in short pieces so long answers aren't
  // cut off by the browser. Tapping again, or another answer's button, stops it.
  let speaking = null;
  function speakButton(box) {
    const b = el("button", "speak", "▶ Listen"); b.type = "button";
    b.setAttribute("aria-label", "Read this answer aloud"); b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => {
      const synth = window.speechSynthesis;
      const was = speaking;
      synth.cancel();
      if (was) { was.setAttribute("aria-pressed", "false"); was.textContent = "▶ Listen"; speaking = null; }
      if (was === b) return;
      const parts = [...box.childNodes].filter((n) => !(n.nodeType === 1 && (n.classList.contains("who") || n.classList.contains("drew") || n.classList.contains("attached"))))
        .map((n) => n.textContent).join(" ").replace(/\s+/g, " ").trim();
      const chunks = parts.match(/[^.!?]{1,220}[.!?]*|[^.!?]+/g) || [];
      chunks.forEach((c, i) => {
        const u = new SpeechSynthesisUtterance(c.trim());
        u.lang = navigator.language || "en-US";
        if (i === chunks.length - 1) u.onend = u.onerror = () => { if (speaking === b) { b.setAttribute("aria-pressed", "false"); b.textContent = "▶ Listen"; speaking = null; } };
        synth.speak(u);
      });
      speaking = b; b.setAttribute("aria-pressed", "true"); b.textContent = "■ Stop";
    });
    return b;
  }
  syncMic();

  guard(async () => { await loadStatus(); await loadProjects(); })();
})();
