// Notices a newer live version on resume, shows the version in Settings, refreshes only when asked.
// Never reloads by itself, never caches API responses, never clears storage it does not own.
(function (root) {
  "use strict";
  function shouldNotice(base, cur, guard) { return !!base && !!cur && cur !== base && cur !== guard; }
  root.ACPVersion = { shouldNotice };
  const doc = root.document;
  if (!doc) return;
  const KEY = "acp.drafts", GUARD = "acp.reloadedFor";
  let base = null, latest = null, last = 0, dismissed = false;
  const ss = () => { try { return root.sessionStorage; } catch (e) { return null; } };
  const guard = () => { try { return ss().getItem(GUARD); } catch (e) { return null; } };
  async function fetchVersion() {
    try {
      const r = await fetch("/api/version", { cache: "no-store", credentials: "omit" });
      if (!r.ok) return null;
      const b = await r.json();
      return typeof b.version === "string" && /^[A-Za-z0-9]{1,12}$/.test(b.version) ? b.version : null;
    } catch (e) { return null; }
  }
  const fields = () => Array.from(doc.querySelectorAll("textarea[id],input[id]")).filter((el) => el.tagName === "TEXTAREA" || /^(text|search|email|url|tel)$/.test(el.type || "text"));
  function saveDrafts() {
    const s = ss(); if (!s) return;
    const d = {};
    for (const el of fields()) if (el.value && el.value.length <= 20000) d[el.id] = el.value;
    try { if (Object.keys(d).length) s.setItem(KEY, JSON.stringify({ path: root.location.pathname, d })); } catch (e) { /* full: skip */ }
  }
  function restoreDrafts() {
    const s = ss(); if (!s) return;
    let raw;
    try { raw = s.getItem(KEY); s.removeItem(KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      const o = JSON.parse(raw);
      if (o.path !== root.location.pathname) return;
      for (const el of fields()) if (!el.value && typeof o.d[el.id] === "string") { el.value = o.d[el.id]; el.dispatchEvent(new root.Event("input", { bubbles: true })); }
    } catch (e) { /* ignore bad draft */ }
  }
  function refresh() {
    saveDrafts();
    try { if (latest) ss().setItem(GUARD, latest); } catch (e) { /* ignore */ }
    root.location.reload();
  }
  function showNotice() {
    if (doc.getElementById("acpUpdate")) return;
    const n = doc.createElement("div");
    n.id = "acpUpdate"; n.setAttribute("role", "status");
    n.style.cssText = "position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:50;display:flex;gap:8px;align-items:center;justify-content:space-between;padding:10px 14px;border-radius:12px;background:#0b2233;color:#fff;border:1px solid #16b6ca";
    const t = doc.createElement("span"); t.textContent = "A new version is available.";
    const go = doc.createElement("button"); go.type = "button"; go.className = "ax-btn"; go.textContent = "Refresh"; go.addEventListener("click", refresh);
    const no = doc.createElement("button"); no.type = "button"; no.className = "ax-btn ghost"; no.textContent = "Later";
    no.addEventListener("click", () => { dismissed = true; n.remove(); });
    n.append(t, go, no); doc.body.appendChild(n);
  }
  function paint() {
    const el = doc.getElementById("stVer"); if (!el) return;
    el.textContent = base ? "Version " + base + (latest && latest !== base ? " · update available" : " · up to date") : "Version unknown (offline?)";
  }
  async function check(force) {
    const now = Date.now();
    if (!force && now - last < 30000) return;
    last = now;
    const v = await fetchVersion();
    if (v) { latest = v; if (base === null) base = v; }
    paint();
    if (v && !dismissed && shouldNotice(base, v, guard())) showNotice();
  }
  function start() {
    restoreDrafts();
    const btn = doc.getElementById("stVerBtn");
    if (btn) btn.addEventListener("click", async () => { btn.disabled = true; await check(true); refresh(); });
    check(true);
    doc.addEventListener("visibilitychange", () => { if (doc.visibilityState === "visible") check(false); });
    root.addEventListener("pageshow", () => check(false));
    root.addEventListener("online", () => check(false));
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start); else start();
})(typeof window !== "undefined" ? window : globalThis);
