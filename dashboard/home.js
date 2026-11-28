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
      const o = await W.load();
      const c = W.counts(o);
      $("sOpen").textContent = c.open; $("sReview").textContent = c.review; $("sBlocked").textContent = c.blocked; $("sDone").textContent = c.done;
      const list = $("hWork"); list.replaceChildren();
      const items = W.activeWork(o, 4);
      if (!items.length) list.append(W.el("li", "ax-empty", "Nothing open right now."));
      for (const it of items) list.append(W.row(it, o.activity));
      W.watchActivity(o);
    } catch (e) {
      $("hWork").replaceChildren(W.el("li", "ax-empty", "Work couldn't be loaded."));
      const m = $("hMsg"); m.hidden = false; m.className = "ax-msg err"; m.textContent = e.message;
    }
  })();
})();
