// Sign-in page. The password goes to the server once; the server answers with an HttpOnly session cookie.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const S = window.ACPSession;
  const next = S.safeNext(new URLSearchParams(location.search).get("next"));
  function say(text, cls) { const m = $("siMsg"); m.hidden = !text; m.className = "ax-msg" + (cls ? " " + cls : ""); m.textContent = text || ""; }

  // Already signed in on this device: straight through.
  S.call("session").then((r) => { if (r.status === 200) location.replace(next); });

  $("siEye").addEventListener("click", () => {
    const show = $("siPass").type === "password";
    $("siPass").type = show ? "text" : "password";
    $("siEye").setAttribute("aria-pressed", String(show));
    $("siEye").setAttribute("aria-label", show ? "Hide password" : "Show password");
  });
  $("siForgot").addEventListener("click", () => {
    const open = $("siHelp").hidden;
    $("siHelp").hidden = !open;
    $("siForgot").setAttribute("aria-expanded", String(open));
  });
  $("siRemember").addEventListener("change", () => {
    $("siStay").textContent = $("siRemember").checked
      ? "Remember me keeps this device signed in for 30 days, renewed each day you use it."
      : "Without Remember me you're signed out when the browser closes, or after 12 hours.";
  });
  $("siForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("siEmail").value.trim(), password = $("siPass").value;
    if (!email) { say("Enter your email address.", "err"); $("siEmail").focus(); return; }
    if (!password) { say("Enter your password.", "err"); $("siPass").focus(); return; }
    $("siGo").disabled = true; say("Signing in…");
    const r = await S.call("sign_in", { email, password, remember: $("siRemember").checked });
    if (r.status === 200) { say("Signed in.", "ok"); location.replace(next); return; }
    $("siGo").disabled = false;
    say(typeof r.body.error === "string" ? r.body.error : "Sign-in failed (" + r.status + "). Try again.", "err");
    if (r.status === 401) { $("siPass").select(); }
  });
})();
