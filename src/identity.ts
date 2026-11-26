// Each AI's own GitHub identity (2026-11-25, owner decision: "build it for each account").
//
// Every AI used to act on GitHub through one shared token, so GitHub recorded all of their work as the owner's.
// This gives each AI its own GitHub App (the same way Copilot or Dependabot appear as "name[bot]"): free, no extra
// email, and each app can be installed on just the repos the owner chooses.
//
// Setup per AI (the AI's key in capitals: CLAUDE, CHATGPT, PERPLEXITY). Only two values are needed:
//   App ID       repo variable ARNEXYIA_<AI>_BOT   (or ACP_GH_APP_<AI>_ID)
//   private key  repo secret   ARNEXYIA_<AI>_BOT   (or ACP_GH_APP_<AI>_KEY; the .pem, "\n" escapes accepted)
// The workflows map those names onto ACP_GH_APP_<AI>_ID / _KEY, which is what this module reads.
// Optional, looked up with the app's own key when unset:
//   ACP_GH_APP_<AI>_INSTALLATION  the installation id (found by asking GitHub where the app is installed)
//   ACP_GH_APP_<AI>_SLUG          the app's URL name (GitHub shows the app as <slug>[bot])
//
// Rules:
// - An AI with ID and KEY set acts as its app. Its token is minted per run, lasts an hour, and is never shown to a
//   model. If minting fails, the call fails: it never falls back to the shared account, so GitHub's record of who did
//   what stays true.
// - An AI with none of them set uses the shared GITHUB_TOKEN, exactly as today.
// - A half-configured AI (ID without KEY, or the reverse) is refused, so a typo can't silently fall back.
import { createPrivateKey, createSign } from "node:crypto";
import type { AgentKey } from "./config.ts";

type Fetch = typeof fetch;
export interface GitHubApp {
  appId: string;
  /** Looked up from GitHub when not set: the app's one installation. */
  installationId?: string;
  privateKey: string;
  /** The app's URL name; its GitHub login is `${slug}[bot]`. */
  slug?: string;
}
export type AppSetting = GitHubApp | { error: string } | undefined;

const varName = (agent: AgentKey, part: string) => `ACP_GH_APP_${agent.toUpperCase()}_${part}`;

/** One AI's app settings: complete, missing (undefined: use the shared token), or an error for a partial setup. */
export function appSettingFor(env: Record<string, string | undefined>, agent: AgentKey): AppSetting {
  const get = (part: string) => env[varName(agent, part)]?.trim() || undefined;
  const appId = get("ID"), installationId = get("INSTALLATION"), rawKey = get("KEY"), slug = get("SLUG");
  if (!appId && !rawKey && !installationId) return undefined;
  if (!appId || !rawKey) return { error: `${agent}'s GitHub App is only partly set up: its App ID (variable ARNEXYIA_${agent.toUpperCase()}_BOT) and private key (secret ARNEXYIA_${agent.toUpperCase()}_BOT) are both needed` };
  if (!/^\d{1,12}$/.test(appId) || (installationId !== undefined && !/^\d{1,15}$/.test(installationId))) return { error: `${agent}'s GitHub App ID and installation id must be numbers` };
  if (slug !== undefined && !/^[a-z0-9][a-z0-9-]{0,38}$/.test(slug)) return { error: `${varName(agent, "SLUG")} must be the app's URL name` };
  const privateKey = readableKey(rawKey!);
  if (!privateKey) {
    return { error: `${agent}'s GitHub App key (secret ARNEXYIA_${agent.toUpperCase()}_BOT, or ACP_GH_APP_${agent.toUpperCase()}_KEY if that secret exists, which wins) is not a readable private key (${keyShape(rawKey!)}): paste the whole downloaded .pem file, from -----BEGIN to the END----- line` };
  }
  return { appId, privateKey, ...(installationId ? { installationId } : {}), ...(slug ? { slug } : {}) };
}

/** The key as a PEM node can read, or undefined. A paste of only the lines between BEGIN and END (no header lines) is accepted too: GitHub App keys are RSA, so the header is added back. */
export function readableKey(raw: string): string | undefined {
  const tries = [normalizePem(raw)];
  const body = raw.replace(/\\n/g, "\n").replace(/\s+/g, "");
  if (!/-----/.test(raw) && /^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    for (const label of ["RSA PRIVATE KEY", "PRIVATE KEY"]) tries.push(normalizePem(`-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`));
  }
  for (const k of tries) { try { createPrivateKey(k); return k; } catch { /* next */ } }
  return undefined;
}
/**
 * Rebuilds a pasted .pem so copy-paste damage doesn't matter: "\n" escapes, Windows line endings, or line breaks
 * turned into spaces. Only the BEGIN/END lines and the base64 between them are kept.
 */
/** Says what a refused key looks like, without revealing any of it: only its length and which markers it has. */
export function keyShape(raw: string): string {
  const t = raw.trim();
  if (/^SHA256:/i.test(t)) return "it is the key's SHA256 fingerprint, not the key";
  const begin = /-----BEGIN [A-Z ]+-----/.test(t), end = /-----END [A-Z ]+-----/.test(t);
  const what = !begin ? "no -----BEGIN line" : !end ? "a -----BEGIN line but no -----END line, so it was cut off" : "both the BEGIN and END lines, but the text between them is damaged";
  return `${t.length} characters, ${what}; a real key is about 1,600 to 1,700 characters`;
}
export function normalizePem(raw: string): string {
  const text = raw.replace(/\\n/g, "\n").trim();
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!m) return text;
  const body = m[2]!.replace(/\s+/g, "");
  return `-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END ${m[1]}-----\n`;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/** The short-lived JWT GitHub requires to ask for an installation token (RS256, valid 9 minutes). */
export function appJwt(app: GitHubApp, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // Issued a minute early to allow for clock drift, as GitHub recommends.
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: app.appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(app.privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

/**
 * Hands out the right GitHub token for each AI. Installation tokens are cached until 5 minutes before they expire.
 * `tokenFor` resolves to undefined only when the AI has no app AND there is no shared token.
 */
export function createTokenSource(opts: {
  apps: Partial<Record<AgentKey, AppSetting>>;
  sharedToken?: string;
  f?: Fetch;
  now?: () => number;
}) {
  const f = opts.f ?? fetch;
  const now = opts.now ?? Date.now;
  const cache = new Map<AgentKey, { token: string; until: number }>();
  const installs = new Map<AgentKey, string>();
  const asApp = async (agent: AgentKey, app: GitHubApp, path: string, method = "GET") => {
    const res = await f(`https://api.github.com${path}`, {
      method,
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${appJwt(app, now())}`, "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(30_000),
    });
    const j: any = await res.json().catch(() => ({}));
    // No fallback to the shared account: acting as the wrong identity is worse than not acting.
    if (!res.ok) throw new Error(`GitHub refused ${agent}'s app token (${res.status}${j.message ? `: ${j.message}` : ""})`);
    return j;
  };
  /** The installation to use: the configured one, else the app's only installation. */
  const installationOf = async (agent: AgentKey, app: GitHubApp): Promise<string> => {
    if (app.installationId) return app.installationId;
    const known = installs.get(agent);
    if (known) return known;
    const list = await asApp(agent, app, "/app/installations?per_page=100");
    if (!Array.isArray(list) || list.length === 0) throw new Error(`${agent}'s GitHub App isn't installed anywhere yet (Install App → choose the repos)`);
    if (list.length > 1) throw new Error(`${agent}'s GitHub App is installed in ${list.length} places; set ${varName(agent, "INSTALLATION")} to say which`);
    const id = String(list[0].id);
    installs.set(agent, id);
    return id;
  };
  return {
    /** "app" when the AI acts as its own GitHub App, "shared" when it uses the shared token. */
    identity(agent: AgentKey): "app" | "shared" {
      const s = opts.apps[agent];
      return s && !("error" in s) ? "app" : "shared";
    },
    async tokenFor(agent: AgentKey): Promise<string | undefined> {
      const s = opts.apps[agent];
      if (!s) return opts.sharedToken;
      if ("error" in s) throw new Error(s.error);
      const hit = cache.get(agent);
      if (hit && hit.until > now()) return hit.token;
      const j = await asApp(agent, s, `/app/installations/${await installationOf(agent, s)}/access_tokens`, "POST");
      if (typeof j.token !== "string") throw new Error(`GitHub refused ${agent}'s app token (no token returned)`);
      const expires = Date.parse(j.expires_at);
      cache.set(agent, { token: j.token, until: (Number.isNaN(expires) ? now() + 3_600_000 : expires) - 5 * 60_000 });
      return j.token;
    },
  };
}

/** The app's URL name, read from GitHub with the app's own key (GET /app). Its GitHub login is `${slug}[bot]`. */
export async function appSlug(app: GitHubApp, f: Fetch = fetch, nowMs = Date.now()): Promise<string> {
  if (app.slug) return app.slug;
  const res = await f("https://api.github.com/app", {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${appJwt(app, nowMs)}`, "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(30_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || typeof j.slug !== "string") throw new Error(`GitHub wouldn't say app ${app.appId}'s name (${res.status}${j.message ? `: ${j.message}` : ""})`);
  return j.slug.toLowerCase();
}
