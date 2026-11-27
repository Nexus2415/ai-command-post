// Signing in and staying signed in. The session itself is an HttpOnly cookie the server sets after sign-in: this
// script never sees it, and no password or token is ever kept in browser storage (ARN-53).
(function (root) {
  "use strict";
  // Where to go after signing in: only a page on this site (a path starting with one "/"), never another address.
  function safeNext(raw) {
    const s = String(raw || "");
    return /^\/(?!\/)[A-Za-z0-9._~\-\/]*(\?[A-Za-z0-9._~\-=&%+]*)?$/.test(s) && !s.includes("\\") ? s : "/home.html";
  }
  async function call(action, args) {
    let r;
    try {
      r = await fetch("/api/workspace", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, args: args || {} }) });
    } catch (e) { return { status: 0, body: { error: "Network error: couldn't reach the server." } }; }
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }
  // Sends you to the sign-in page, then back here. Returns a promise that never settles, so callers stop.
  function expired() {
    if (root.location) root.location.replace("/signin.html?next=" + encodeURIComponent(root.location.pathname + root.location.search));
    return new Promise(function () {});
  }
  // Who is signed in ({ email, remember }), or off to the sign-in page.
  async function current() {
    const r = await call("session");
    if (r.status === 401) return expired();
    if (r.status !== 200) throw new Error(typeof r.body.error === "string" ? r.body.error : "Couldn't check your sign-in.");
    return r.body;
  }
  async function signOut() {
    await call("sign_out");
    root.location.replace("/signin.html");
  }
  // The name used in the greeting: one you set in Settings (this device only), else none.
  function displayName() {
    try { return (root.localStorage.getItem("acp.name") || "").slice(0, 40); } catch (e) { return ""; }
  }
  root.ACPSession = { call, current, expired, signOut, safeNext, displayName };
})(typeof window !== "undefined" ? window : globalThis);
