// Each AI's own GitHub identity (2026-11-25, owner decision: "build it for each account").
//
// Every AI used to act on GitHub through one shared token, so GitHub recorded all of their work as the owner's.
// This gives each AI its own GitHub App (the same way Copilot or Dependabot appear as "name[bot]"): free, no extra
// email, and each app can be installed on just the repos the owner chooses.
//
// Setup per AI (secrets/variables named with the AI's key in capitals: CLAUDE, CHATGPT, PERPLEXITY, GEMINI):
//   ACP_GH_APP_<AI>_ID            the app's numeric App ID
//   ACP_GH_APP_<AI>_INSTALLATION  the installation id (the number at the end of the app's "Configure" page URL)
//   ACP_GH_APP_<AI>_KEY           the app's private key (.pem contents; "\n" escapes are accepted)
//   ACP_GH_APP_<AI>_SLUG          the app's URL name, e.g. "arnexyia-claude" (GitHub shows it as arnexyia-claude[bot])
//
// Rules:
// - An AI with all of ID, INSTALLATION and KEY set acts as its app. Its token is minted per run, lasts an hour, and
//   is never shown to a model. If minting fails, the call fails: it never falls back to the shared account, so
//   GitHub's record of who did what stays true.
// - An AI with none of them set uses the shared GITHUB_TOKEN, exactly as today.
// - A half-configured AI (some but not all three) is refused, so a typo can't silently fall back.
import { createPrivateKey, createSign } from "node:crypto";
import type { AgentKey } from "./config.ts";

type Fetch = typeof fetch;
export interface GitHubApp {
  appId: string;
  installationId: string;
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
  const set = [appId, installationId, rawKey].filter(Boolean).length;
  if (set === 0) return undefined;
  if (set < 3) return { error: `${agent}'s GitHub App is only partly set up: ${varName(agent, "ID")}, ${varName(agent, "INSTALLATION")} and ${varName(agent, "KEY")} are all needed` };
  if (!/^\d{1,12}$/.test(appId!) || !/^\d{1,15}$/.test(installationId!)) return { error: `${agent}'s GitHub App ID and installation id must be numbers` };
  if (slug !== undefined && !/^[a-z0-9][a-z0-9-]{0,38}$/.test(slug)) return { error: `${varName(agent, "SLUG")} must be the app's URL name` };
  const privateKey = rawKey!.replace(/\\n/g, "\n");
  try { createPrivateKey(privateKey); } catch { return { error: `${varName(agent, "KEY")} is not a readable private key` }; }
  return { appId: appId!, installationId: installationId!, privateKey, ...(slug ? { slug } : {}) };
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
      const res = await f(`https://api.github.com/app/installations/${s.installationId}/access_tokens`, {
        method: "POST",
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${appJwt(s, now())}`, "x-github-api-version": "2022-11-28" },
        signal: AbortSignal.timeout(30_000),
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok || typeof j.token !== "string") {
        // No fallback to the shared account: acting as the wrong identity is worse than not acting.
        throw new Error(`GitHub refused ${agent}'s app token (${res.status}${j.message ? `: ${j.message}` : ""})`);
      }
      const expires = Date.parse(j.expires_at);
      cache.set(agent, { token: j.token, until: (Number.isNaN(expires) ? now() + 3_600_000 : expires) - 5 * 60_000 });
      return j.token;
    },
  };
}
