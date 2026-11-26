import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import { appJwt, appSettingFor, createTokenSource, type GitHubApp } from "../src/identity.ts";
import { runTool, type ToolEnv } from "../src/tools.ts";

// Each AI's own GitHub App (src/identity.ts). A throwaway key made in the test and a fake GitHub only.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const env = (extra: Record<string, string> = {}) => ({
  ACP_GH_APP_CLAUDE_ID: "12345",
  ACP_GH_APP_CLAUDE_INSTALLATION: "678",
  ACP_GH_APP_CLAUDE_KEY: PEM.replace(/\n/g, "\\n"), // as pasted into a one-line secret
  ACP_GH_APP_CLAUDE_SLUG: "arnexyia-claude",
  ...extra,
});

test("an AI's app is read from its own settings; partial or broken settings are refused, never ignored", () => {
  const s = appSettingFor(env(), "claude") as GitHubApp;
  assert.equal(s.appId, "12345");
  assert.equal(s.installationId, "678");
  assert.equal(s.slug, "arnexyia-claude");
  assert.match(s.privateKey, /^-----BEGIN PRIVATE KEY-----\n/);
  assert.equal(appSettingFor(env(), "chatgpt"), undefined, "no settings = shared account");
  assert.match((appSettingFor({ ACP_GH_APP_CHATGPT_ID: "1" }, "chatgpt") as any).error, /only partly set up/);
  assert.match((appSettingFor(env({ ACP_GH_APP_CLAUDE_ID: "abc" }), "claude") as any).error, /must be numbers/);
  assert.match((appSettingFor(env({ ACP_GH_APP_CLAUDE_KEY: "not a key" }), "claude") as any).error, /not a readable private key/);
  assert.match((appSettingFor(env({ ACP_GH_APP_CLAUDE_SLUG: "Bad Slug!" }), "claude") as any).error, /URL name/);
  const cfg = loadConfig(env());
  assert.deepEqual(Object.keys(cfg.githubApps), ["claude"]);
});

test("the app JWT is RS256, signed by the app's key, issued by its App ID, and short-lived", () => {
  const app = appSettingFor(env(), "claude") as GitHubApp;
  const now = Date.parse("2026-11-25T12:00:00Z");
  const [h, b, sig] = appJwt(app, now).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h!, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const body = JSON.parse(Buffer.from(b!, "base64url").toString());
  assert.equal(body.iss, "12345");
  assert.equal(body.iat, now / 1000 - 60);
  assert.ok(body.exp - body.iat <= 600, "GitHub accepts at most 10 minutes");
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(sig!, "base64url")));
});

test("an AI with an app gets its own installation token, cached until near expiry; others use the shared token", async () => {
  const calls: { url: string; auth: string }[] = [];
  let clock = Date.parse("2026-11-25T12:00:00Z");
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), auth: init.headers.authorization });
    return new Response(JSON.stringify({ token: `ghs_app_${calls.length}`, expires_at: new Date(clock + 3_600_000).toISOString() }), { status: 201 });
  }) as typeof fetch;
  const cfg = loadConfig(env());
  const tokens = createTokenSource({ apps: cfg.githubApps, sharedToken: "ghp_shared", f, now: () => clock });
  assert.equal(tokens.identity("claude"), "app");
  assert.equal(tokens.identity("chatgpt"), "shared");
  assert.equal(await tokens.tokenFor("claude"), "ghs_app_1");
  assert.equal(calls[0]!.url, "https://api.github.com/app/installations/678/access_tokens");
  assert.match(calls[0]!.auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(await tokens.tokenFor("claude"), "ghs_app_1", "cached");
  clock += 56 * 60_000; // inside the last 5 minutes
  assert.equal(await tokens.tokenFor("claude"), "ghs_app_2", "renewed before it expires");
  assert.equal(await tokens.tokenFor("chatgpt"), "ghp_shared");
  assert.equal(calls.length, 2, "the shared token needs no call");
});

test("when GitHub refuses an app token, the call fails: it never falls back to the shared account", async () => {
  const f = (async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })) as typeof fetch;
  const tokens = createTokenSource({ apps: loadConfig(env()).githubApps, sharedToken: "ghp_shared", f });
  await assert.rejects(tokens.tokenFor("claude"), /GitHub refused claude's app token \(401: Bad credentials\)/);
  const partial = createTokenSource({ apps: loadConfig({ ACP_GH_APP_CLAUDE_ID: "1" }).githubApps, sharedToken: "ghp_shared" });
  await assert.rejects(partial.tokenFor("claude"), /only partly set up/);
});

test("GitHub tools use the AI's own token when it has one", async () => {
  const seen: string[] = [];
  const f = (async (_url: any, init: any) => {
    seen.push(init.headers.authorization);
    return new Response(JSON.stringify({ items: [] }));
  }) as typeof fetch;
  const base: ToolEnv = {
    githubToken: "ghp_shared", dryRun: true, f,
    policy: { allowPullRequests: false, allowedRepos: ["acme/app"] },
    comment: async () => {}, requestApproval: async () => {},
  };
  await runTool({ tool: "github.search_issues", input: { repo: "acme/app", query: "x" } }, ["github.search_issues"], { ...base, githubAuth: async () => "ghs_own" });
  await runTool({ tool: "github.search_issues", input: { repo: "acme/app", query: "x" } }, ["github.search_issues"], base);
  assert.deepEqual(seen, ["Bearer ghs_own", "Bearer ghp_shared"]);
});
