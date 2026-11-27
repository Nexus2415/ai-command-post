// Settings: who is signed in, sign out, the greeting name (this device only), Stop everything, spending, and links.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const S = window.ACPSession;
  const money = (n) => "$" + Number(n || 0).toFixed(2);
  async function post(action, args) {
    const r = await S.call(action, args);
    if (r.status === 401) return S.expired();
    if (r.status !== 200) throw new Error(typeof r.body.error === "string" ? r.body.error : "Something went wrong (" + r.status + ").");
    return r.body;
  }
  function say(text, cls) { const m = $("stMsg"); m.hidden = !text; m.className = "ax-msg" + (cls ? " " + cls : ""); m.textContent = text || ""; }
  const stop = window.ACPStopSwitch.mount($("stopSwitch"), { post });

  $("stOut").addEventListener("click", () => { $("stOut").disabled = true; S.signOut(); });
  try { $("stName").value = localStorage.getItem("acp.name") || ""; } catch (e) { /* storage blocked: the field stays empty */ }
  $("stNameForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const n = $("stName").value.trim().slice(0, 40);
    try { if (n) localStorage.setItem("acp.name", n); else localStorage.removeItem("acp.name"); say("Saved on this device.", "ok"); }
    catch (err) { say("This browser won't save it. The greeting stays without a name.", "err"); }
  });
  $("stSecBtn").addEventListener("click", () => {
    const open = $("stSec").hidden; $("stSec").hidden = !open; $("stSecBtn").setAttribute("aria-expanded", String(open));
  });
  (async () => {
    try {
      const me = await S.current();
      const until = Date.parse(me.expiresAt);
      $("stWho").textContent = "Signed in as " + me.email + (me.remember && isFinite(until) ? " · remembered until " + new Date(until).toLocaleDateString([], { month: "short", day: "numeric" }) : "");
    } catch (e) { $("stWho").textContent = "Couldn't check your sign-in."; }
    try {
      const st = await post("models", {});
      if (st.control) stop.show(st.control);
      const b = st.budget || {};
      $("stBudget").textContent = "This month " + money(b.monthSpent) + " of " + money(b.month) + " · up to " + money(b.thread) + " per thread. The AIs can't raise these.";
    } catch (e) { $("stBudget").textContent = "Couldn't load spending: " + e.message; }
  })();
})();
