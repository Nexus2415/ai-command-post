// Home: greeting, four counts from Linear, an ask box that continues in Command, and the most urgent work.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const W = window.ACPWork, S = window.ACPSession;
  $("hHello").textContent = W.greeting(new Date().getHours(), S.displayName());
  // The ask box opens Command with your words in the question box. Nothing is sent to any AI until you press send there.
  $("askForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = $("askText").value.trim();
    location.assign("/workspace.html" + (t ? "?ask=" + encodeURIComponent(t) : ""));
  });
  (async () => {
    try {
      await S.current();
      const apply=o=>{
      $("hMsg").hidden=true;
      const c=W.counts(o);
      $("sOpen").textContent = c.open; $("sReview").textContent = c.review; $("sBlocked").textContent = c.blocked; $("sDone").textContent = c.done;
      W.renderRows($("hWork"),W.activeWork(o,4),o.activity,"Nothing open right now.");
      };
      const o=await W.load(); apply(o);
      W.watchActivity(o,apply,()=>{const m=$("hMsg");m.hidden=false;m.className="ax-msg err";m.textContent="Refresh unavailable. Showing last known work; activity unverified.";});
    } catch (e) {
      $("hWork").replaceChildren(W.el("li", "ax-empty", "Work couldn't be loaded."));
      const m = $("hMsg"); m.hidden = false; m.className = "ax-msg err"; m.textContent = e.message;
    }
  })();
})();
