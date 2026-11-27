// "Stop everything": one switch that halts all AI activity in the workspace. Shared by the dashboard and the
// workspace page. Pressing Stop acts at once (no confirm, it's meant for a hurry); turning AI back on asks first.
// The server fails closed: if it can't read the switch, it reports "stopped" and runs nothing.
// Rendered with textContent only.
(function () {
  "use strict";
  let password = "";
  // Used when the page doesn't pass its own request function. The password stays in memory for this tab only.
  async function defaultPost(action, args, retry) {
    let r;
    try {
      r = await fetch("/api/workspace", { method: "POST", headers: { "content-type": "application/json", "x-acp-password": password }, body: JSON.stringify({ action, args: args || {} }) });
    } catch (e) { throw new Error("Network error: couldn't reach the server."); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && retry !== false) {
      if (window.ACPSession) return window.ACPSession.expired();
    }
    if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "Something went wrong (" + r.status + ").");
    return j;
  }

  function mount(root, opts) {
    const post = (opts && opts.post) || defaultPost;
    const onChange = (opts && opts.onChange) || function () {};
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const btn = el("button", "stopbtn", "Stop everything");
    btn.type = "button";
    btn.id = "stopBtn";
    const state = el("span", "stopstate");
    state.setAttribute("role", "status");
    state.setAttribute("aria-live", "assertive");
    const resume = el("button", "resumebtn", "Turn AI back on");
    resume.type = "button";
    resume.id = "resumeBtn";
    resume.hidden = true;
    root.replaceChildren(btn, state, resume);
    let stopped = null;

    function show(s) {
      stopped = s.stopped;
      root.dataset.stopped = String(s.stopped);
      btn.hidden = s.stopped;
      resume.hidden = !s.stopped;
      state.textContent = s.stopped ? (s.reason || "Everything is stopped.") : "";
      onChange(s);
    }
    btn.addEventListener("click", async () => {
      // The page stops its own work first (cancels waiting requests), then the server is told.
      onChange({ stopped: true, reason: "Stopping…", local: true });
      btn.disabled = true;
      state.textContent = "Stopping…";
      try { show(await post("set_control", { stopped: true })); }
      catch (e) { state.textContent = "Couldn't reach the server to stop: " + e.message + " Try again."; }
      finally { btn.disabled = false; }
    });
    resume.addEventListener("click", async () => {
      if (!window.confirm("Turn AI back on? The AIs can answer, use tools and spend again, within the caps.")) return;
      resume.disabled = true;
      try { show(await post("set_control", { stopped: false })); }
      catch (e) { state.textContent = "Couldn't turn AI back on: " + e.message; }
      finally { resume.disabled = false; }
    });
    const refresh = async () => { try { show(await post("control")); } catch (e) { if (stopped === null) state.textContent = ""; } };
    return { refresh, show, get stopped() { return stopped; } };
  }
  window.ACPStopSwitch = { mount };
})();
