import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import { appJwt, appSettingFor, appSlug, createTokenSource, type GitHubApp } from "../src/identity.ts";
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

test("only the App ID and key are needed: the installation is looked up once, and a partial setup is still refused", async () => {
  const apps = loadConfig({ ACP_GH_APP_CLAUDE_ID: "12345", ACP_GH_APP_CLAUDE_KEY: PEM }).githubApps;
  assert.equal((apps.claude as GitHubApp).installationId, undefined);
  const urls: string[] = [];
  const f = (async (url: any) => {
    urls.push(String(url));
    if (String(url).includes("/app/installations?")) return new Response(JSON.stringify([{ id: 991 }]));
    return new Response(JSON.stringify({ token: "ghs_found", expires_at: "2026-11-25T13:00:00Z" }));
  }) as typeof fetch;
  const tokens = createTokenSource({ apps, f, now: () => Date.parse("2026-11-25T12:00:00Z") });
  assert.equal(await tokens.tokenFor("claude"), "ghs_found");
  assert.equal(urls[1], "https://api.github.com/app/installations/991/access_tokens");
  assert.match((appSettingFor({ ACP_GH_APP_CLAUDE_KEY: PEM }, "claude") as any).error, /ARNEXYIA_CLAUDE_BOT/);
  // Not installed, or installed in more than one place: refuse rather than guess.
  for (const [list, why] of [[[], /isn't installed/], [[{ id: 1 }, { id: 2 }], /installed in 2 places/]] as const) {
    const g = (async () => new Response(JSON.stringify(list))) as typeof fetch;
    await assert.rejects(createTokenSource({ apps, f: g, sharedToken: "ghp_shared" }).tokenFor("claude"), why);
  }
});

test("the app's name is read from GitHub with its own key", async () => {
  const app = appSettingFor({ ACP_GH_APP_CLAUDE_ID: "12345", ACP_GH_APP_CLAUDE_KEY: PEM }, "claude") as GitHubApp;
  let auth = "";
  const f = (async (url: any, init: any) => { auth = init.headers.authorization; assert.equal(String(url), "https://api.github.com/app"); return new Response(JSON.stringify({ slug: "arnexyia-claude-bot" })); }) as typeof fetch;
  assert.equal(await appSlug(app, f), "arnexyia-claude-bot");
  assert.match(auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  await assert.rejects(appSlug(app, (async () => new Response("{}", { status: 401 })) as typeof fetch), /wouldn't say/);
});

test("the provenance secret is also read under the spelling ACP_PROVENCE_SECRET", () => {
  assert.ok(loadConfig({ ACP_PROVENCE_SECRET: "x".repeat(40) }).provenanceSecret);
});

test("a pasted key survives copy-paste damage, and an unreadable one says what to paste", () => {
  const flat = PEM.trim().replace(/\n/g, " "); // line breaks turned into spaces
  const crlf = PEM.replace(/\n/g, "\r\n");
  for (const k of [flat, crlf, `  ${PEM}  `]) {
    const s = appSettingFor({ ACP_GH_APP_CLAUDE_ID: "1", ACP_GH_APP_CLAUDE_KEY: k }, "claude") as GitHubApp;
    assert.ok(!("error" in s), "readable");
  }
  const bad = appSettingFor({ ACP_GH_APP_CLAUDE_ID: "1", ACP_GH_APP_CLAUDE_KEY: "SHA256:abc123" }, "claude") as any;
  assert.match(bad.error, /secret ARNEXYIA_CLAUDE_BOT.*whole downloaded \.pem/);
  assert.ok(!bad.error.includes("abc123"), "the reason never repeats the value");
});

test("the Claude key is also read under the owner's secret name ANTHROPIC_API_KE", () => {
  assert.equal(loadConfig({ ANTHROPIC_API_KE: "sk-ant-x" }).keys.anthropic, "sk-ant-x");
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: "a", ANTHROPIC_API_KE: "b" }).keys.anthropic, "a", "the standard name wins");
});

test("a refused app key says what it looks like without showing it", () => {
  const e = (k: string) => (appSettingFor(env({ ACP_GH_APP_CLAUDE_ID: "1", ACP_GH_APP_CLAUDE_KEY: k }), "claude") as any).error as string;
  assert.match(e("SHA256:abcdEFGH1234"), /SHA256 fingerprint/);
  assert.match(e("abcdef"), /6 characters, no -----BEGIN line/);
  assert.match(e("-----BEGIN RSA PRIVATE KEY-----\nMIIE"), /no -----END line/);
  assert.match(e("-----BEGIN RSA PRIVATE KEY-----\nzzzz\n-----END RSA PRIVATE KEY-----"), /text between them is damaged/);
  assert.doesNotMatch(e("SHA256:abcdEFGH1234"), /abcdEFGH/);
});

test("a key pasted without its BEGIN and END lines is still accepted", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const body = privateKey.split("\n").filter((l) => l && !l.startsWith("-----")).join("\n");
  const s = appSettingFor(env({ ACP_GH_APP_CLAUDE_ID: "1", ACP_GH_APP_CLAUDE_KEY: body }), "claude") as any;
  assert.equal(s.error, undefined);
  assert.match(s.privateKey, /^-----BEGIN RSA PRIVATE KEY-----/);
  assert.match((appSettingFor(env({ ACP_GH_APP_CLAUDE_ID: "1", ACP_GH_APP_CLAUDE_KEY: "QUJDRA==" }), "claude") as any).error, /not a readable private key/);
});
