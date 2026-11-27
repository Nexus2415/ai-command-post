import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { handle } from "../api/workspace.js";
import { handle as consoleHandle } from "../api/console.js";
import { createMemoryStore } from "../api/_lib/workspace-store.js";
import { SESSION_COOKIE, hasSitePassword, makeSessionToken, readSession } from "../api/_lib/site-auth.js";

// Sign in with email + password, then stay signed in through an HttpOnly session cookie. Fakes only.
const env = { ACP_SITE_PASSWORD: "synthetic-password", ACP_WORKSPACE_DB_URL: "https://synthetic.supabase.co", ACP_WORKSPACE_DB_KEY: "synthetic-key" };
const T0 = Date.parse("2026-11-27T12:00:00Z");
const DAY = 86400e3;
const site = { origin: "https://acp.example", host: "acp.example", "sec-fetch-site": "same-origin" };
const req = (action: string, args: object = {}, headers: object = {}) => ({ method: "POST", headers: { ...site, ...headers }, body: { action, args } });
const at = (ms: number) => ({ now: () => new Date(ms) });
const store = createMemoryStore();
const call = (r: object, e: object = env, ms = T0) => handle(r as never, e, () => store, at(ms)) as Promise<any>;
const cookieOf = (out: any) => String(out.cookie || "").split(";")[0]!;
const signIn = (args: object, e: object = env, ms = T0) => call(req("sign_in", { email: "Owner@Example.com", password: "synthetic-password", ...args }), e, ms);

test("signing in sets a secure HttpOnly session cookie; Remember me keeps it for 30 days", async () => {
  const out = await signIn({ remember: true });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { email: "owner@example.com", remember: true });
  assert.match(out.cookie, new RegExp(`^${SESSION_COOKIE}=[^;]+; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$`));
  assert.ok(!JSON.stringify(out.body).includes("synthetic-password"), "the password is never echoed");

  const short = await signIn({ remember: false });
  assert.doesNotMatch(short.cookie, /Max-Age/, "without Remember me the cookie ends with the browser");
  const s = readSession({ headers: { cookie: cookieOf(short) } }, env, T0)!;
  assert.equal(s.exp - s.iat, 12 * 3600, "and the server ends it after 12 hours anyway");
});

test("the session cookie opens every route, until it expires", async () => {
  const cookie = cookieOf(await signIn({ remember: true }));
  const list = await call(req("list_projects", {}, { cookie }));
  assert.equal(list.status, 200, "workspace actions work with the cookie alone, no password header");
  const me = await call(req("session", {}, { cookie }));
  assert.equal(me.status, 200);
  assert.equal(me.body.email, "owner@example.com");
  assert.equal(me.cookie, undefined, "a fresh session isn't reissued");
  // The other routes share the same check.
  assert.equal(hasSitePassword({ headers: { cookie } }, env, T0), true);
  const c = await consoleHandle({ method: "POST", headers: { ...site, cookie }, body: { action: "nope" } } as never, { ...env, LINEAR_API_KEY: "x" });
  assert.equal(c.status, 400, "console accepts the session and goes on to check the request");
  // After 30 days without use, it no longer works.
  assert.equal((await call(req("list_projects", {}, { cookie }), env, T0 + 30 * DAY + 1000)).status, 401);
});

test("a remembered session renews itself, so a device in use stays signed in", async () => {
  const cookie = cookieOf(await signIn({ remember: true }));
  const later = await call(req("session", {}, { cookie }), env, T0 + 20 * DAY);
  assert.equal(later.status, 200);
  assert.match(later.cookie, /Max-Age=2592000/);
  const renewed = cookieOf(later);
  assert.equal((await call(req("list_projects", {}, { cookie: renewed }), env, T0 + 45 * DAY)).status, 200, "valid 30 days from the renewal");
});

test("wrong password, wrong owner email, forged or tampered cookies are refused", async () => {
  const bad = await signIn({ password: "nope" });
  assert.equal(bad.status, 401);
  assert.equal(bad.cookie, undefined);
  const locked = { ...env, ACP_OWNER_EMAIL: "darius@example.com" };
  const wrongEmail = await signIn({}, locked);
  assert.equal(wrongEmail.status, 401);
  assert.deepEqual(wrongEmail.body, bad.body, "same answer for a wrong email and a wrong password");
  assert.equal((await call(req("sign_in", { email: "DARIUS@example.com ", password: "synthetic-password" }), locked)).status, 200);
  assert.equal((await call(req("sign_in", { email: "not-an-email", password: "x" }))).status, 400);

  const good = cookieOf(await signIn({ remember: true }));
  const [name, token] = good.split("=") as [string, string];
  const [payload, sig] = token.split(".") as [string, string];
  const forged = Buffer.from(JSON.stringify({ v: 1, e: "x@y.zz", r: true, iat: T0 / 1000, exp: T0 / 1000 + 99 * 86400 })).toString("base64url");
  for (const cookie of [`${name}=${forged}.${sig}`, `${name}=${payload}.${sig.slice(0, -2)}AA`, `${name}=${payload}`, `${name}=`, `other=${token}`]) {
    assert.equal((await call(req("list_projects", {}, { cookie }))).status, 401, cookie);
  }
  // Changing the site password signs every device out.
  assert.equal((await call(req("list_projects", {}, { cookie: good }), { ...env, ACP_SITE_PASSWORD: "changed" })).status, 401);
  // A token signed for the future is refused.
  const future = makeSessionToken(env, "a@b.cc", true, T0 + DAY);
  assert.equal(readSession({ headers: { cookie: `${SESSION_COOKIE}=${future}` } }, env, T0), null);
});

test("sign-in needs a same-site request, and sign out clears the cookie", async () => {
  const cross = await call(req("sign_in", { email: "a@b.cc", password: "synthetic-password" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }));
  assert.equal(cross.status, 403);
  assert.equal(cross.cookie, undefined);
  const out = await call(req("sign_out"));
  assert.equal(out.status, 200);
  assert.match(out.cookie, /Max-Age=0/);
  assert.equal((await call(req("session"))).status, 401);
  // The password header still works for scripts that aren't browsers.
  assert.equal((await call(req("list_projects", {}, { "x-acp-password": "synthetic-password" }))).status, 200);
  // No site password configured: nobody can sign in.
  assert.equal((await call(req("sign_in", { email: "a@b.cc", password: "" }), { ...env, ACP_SITE_PASSWORD: "" })).status, 503);
});

// ---- Pages ----
const read = (f: string) => readFileSync(new URL(`../dashboard/${f}`, import.meta.url), "utf8");
const PAGES = ["home.html", "workspace.html", "tasks.html", "settings.html", "index.html", "command.html", "tools.html"];

test("every page shares one menu: Home, Command, Tasks, Settings", () => {
  for (const p of PAGES) {
    const html = read(p);
    const nav = html.match(/<nav class="nexia-nav"[^]*?<\/nav>/)?.[0] ?? "";
    assert.deepEqual([...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]), ["/home.html", "/workspace.html", "/tasks.html", "/settings.html"], p);
    assert.equal((nav.match(/aria-current="page"/g) || []).length, 1, p);
    assert.match(html, /<script src="session\.js"><\/script>/, p);
    assert.match(html, /<link rel="stylesheet" href="nexia\.css">/, p);
  }
});

test("no page asks for the password in a pop-up any more, and none stores it", () => {
  for (const f of ["workspace.js", "tools.js", "command.js", "console.js", "stop-switch.js", "index.html", "session.js", "signin.js"]) {
    assert.doesNotMatch(read(f), /prompt\("Password/, f);
    assert.doesNotMatch(read(f), /(localStorage|sessionStorage)\.setItem\([^)]*(pw|password|token)/i, f);
  }
  const html = read("signin.html");
  assert.match(html, /autocomplete="username"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /id="siRemember" type="checkbox" checked/);
});

test("after sign-in you only ever go back to a page on this site", () => {
  const ctx: any = {};
  vm.runInNewContext(read("session.js"), ctx);
  const next = ctx.ACPSession.safeNext;
  assert.equal(next("/tasks.html?tab=review"), "/tasks.html?tab=review");
  for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "", null, "/a b"]) assert.equal(next(bad), "/home.html", String(bad));
});

test("Home and Tasks count work the same way Linear lanes are defined", () => {
  const ctx: any = {};
  vm.runInNewContext(read("work.js"), ctx);
  const W = ctx.ACPWork;
  const o = { issues: [
    { id: "ARN-1", lane: "active", priority: 2, updatedAt: "2026-11-27T10:00:00Z" },
    { id: "ARN-2", lane: "blocked", priority: 3 },
    { id: "ARN-3", lane: "review" },
    { id: "ARN-4", lane: "queued" },
    { id: "ARN-5", lane: "done", updatedAt: "2026-11-20T00:00:00Z" },
    { id: "ARN-6", lane: "done", updatedAt: "2026-11-26T00:00:00Z" },
    { id: "ARN-7", lane: "canceled" },
    { id: "ARN-8", lane: "active", kind: "question" },
    null,
  ] };
  assert.equal(JSON.stringify(W.counts(o)), JSON.stringify({ active: 1, queued: 1, blocked: 1, review: 1, done: 2, open: 3, total: 6 }));
  assert.deepEqual(W.tab(o, "active").map((i: any) => i.id), ["ARN-2", "ARN-1", "ARN-4"], "blocked first");
  assert.deepEqual(W.tab(o, "review").map((i: any) => i.id), ["ARN-3"]);
  assert.deepEqual(W.tab(o, "done").map((i: any) => i.id), ["ARN-6", "ARN-5"], "newest first");
  assert.equal(W.tab(o, "nope").length, 0);
  assert.equal(W.safeUrl("https://linear.app/x/issue/ARN-1"), "https://linear.app/x/issue/ARN-1");
  assert.equal(W.safeUrl("javascript:alert(1)"), null);
  assert.equal(W.greeting(9, "Darius"), "Good morning, Darius");
  assert.equal(W.greeting(20, ""), "Good evening");
});
