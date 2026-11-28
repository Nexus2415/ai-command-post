// Tasks: counts and the task list from Linear, in three tabs. Read-only; "New task" opens the Assign work page.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const W = window.ACPWork, S = window.ACPSession;
  let overview = null;
  const start = new URLSearchParams(location.search).get("tab");
  let current = Object.hasOwn(W.TABS, start || "") ? start : "active";
  const NAMES = { active: "Active", review: "Review", done: "Completed" };

  function show() {
    for (const b of document.querySelectorAll(".ax-seg [role=tab]")) {
      const on = b.dataset.tab === current;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      if (overview) b.textContent = NAMES[b.dataset.tab] + " (" + W.tab(overview, b.dataset.tab).length + ")";
    }
    $("tList").setAttribute("aria-labelledby", "tab-" + current);
    if (!overview) return;
    const items = W.tab(overview, current);
    const list = $("tList");
    W.renderRows(list,items,overview.activity,current === "review" ? "Nothing is waiting for review." : current === "done" ? "Nothing completed yet." : "No active tasks.");
  }
  const tabs = [...document.querySelectorAll(".ax-seg [role=tab]")];
  for (const b of tabs) {
    b.addEventListener("click", () => { current = b.dataset.tab; show(); });
    b.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(b), d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      const n = tabs[(i + d + tabs.length) % tabs.length]; current = n.dataset.tab; show(); n.focus();
    });
  }
  show();
  (async () => {
    try {
      await S.current();
      const apply = o => {
      overview = o;
      $("tMsg").hidden=true;
      const c = W.counts(overview);
      $("cTotal").textContent = c.total; $("cProg").textContent = c.active; $("cReview").textContent = c.review; $("cDone").textContent = c.done;
      const when = Date.parse(overview.fetchedAt);
      $("tFresh").textContent = "From Linear" + (isFinite(when) ? ", " + new Date(when).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "") +
        (overview.hasNextPage ? ". Only the first page of tasks is shown." : ".");
      show();
      };
      apply(await W.load());
      W.watchActivity(overview,apply,() => { const m=$("tMsg"); m.hidden=false; m.className="ax-msg err"; if (overview) overview = {...overview, activity:null}; m.textContent="Refresh unavailable. Showing last known tasks; activity unverified."; });
    } catch (e) {
      $("tList").replaceChildren(W.el("li", "ax-empty", "Tasks couldn't be loaded."));
      const m = $("tMsg"); m.hidden = false; m.className = "ax-msg err"; m.textContent = e.message;
    }
  })();
})();
