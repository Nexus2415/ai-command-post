// Runtime configuration. Every value comes from the environment; nothing secret lives in the repo.

export type AgentKey = "claude" | "chatgpt" | "gemini" | "perplexity";

export interface Config {
  /** Kill switch. When false the engine reads state and reports, but never calls a model or writes anywhere. */
  active: boolean;
  /** When true, every write (Linear, GitHub) is logged instead of performed. Default true. */
  dryRun: boolean;
  /** Hard monthly cap in USD across all paid model calls. 0 = free tiers only. */
  monthlyBudgetUsd: number;
  /** Default lead AI when a command title doesn't name one. */
  defaultLead: AgentKey;
  linearTeamKey: string;
  pollSeconds: number;
  /** Max model turns a worker may take on one task before it must stop and report. */
  maxStepsPerTask: number;
  /** Allow agents to open pull requests (never merge). */
  allowPullRequests: boolean;
  ledgerPath: string;
  keys: {
    linear?: string;
    github?: string;
    firecrawl?: string;
    vercel?: string;
    openai?: string;
    anthropic?: string;
    gemini?: string;
    perplexity?: string;
  };
  models: Record<AgentKey, string>;
  /** Repos agents may touch, as owner/name. Empty = GitHub tools disabled. */
  githubRepos: string[];
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v.trim() === "") return dflt;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

function num(v: string | undefined, dflt: number): number {
  if (v === undefined || v.trim() === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid number in environment: ${v}`);
  return n;
}

const AGENT_KEYS: AgentKey[] = ["claude", "chatgpt", "gemini", "perplexity"];

export function isAgentKey(v: string): v is AgentKey {
  return (AGENT_KEYS as string[]).includes(v);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const lead = (env["ACP_DEFAULT_LEAD"] ?? "claude").toLowerCase();
  if (!isAgentKey(lead)) throw new Error(`ACP_DEFAULT_LEAD must be one of ${AGENT_KEYS.join(", ")}`);
  const opt = (k: string) => {
    const v = env[k]?.trim();
    return v ? v : undefined;
  };
  return {
    active: bool(env["ACP_ACTIVE"], false),
    dryRun: bool(env["ACP_DRY_RUN"], true),
    monthlyBudgetUsd: num(env["ACP_MONTHLY_BUDGET_USD"], 0),
    defaultLead: lead,
    linearTeamKey: env["ACP_LINEAR_TEAM_KEY"] ?? "ARN",
    pollSeconds: num(env["ACP_POLL_SECONDS"], 120),
    maxStepsPerTask: num(env["ACP_MAX_STEPS"], 6),
    allowPullRequests: bool(env["ACP_ALLOW_PULL_REQUESTS"], false),
    ledgerPath: env["ACP_LEDGER_PATH"] ?? ".acp/ledger.json",
    keys: {
      linear: opt("LINEAR_API_KEY"),
      github: opt("GITHUB_TOKEN"),
      firecrawl: opt("FIRECRAWL_API_KEY"),
      vercel: opt("VERCEL_API_KEY"),
      openai: opt("OPENAI_API_KEY"),
      anthropic: opt("ANTHROPIC_API_KEY"),
      gemini: opt("GEMINI_API_KEY"),
      perplexity: opt("PERPLEXITY_API_KEY"),
    },
    // Model ids are configurable because providers rename them often. Verify against each provider's docs.
    models: {
      claude: env["ACP_MODEL_CLAUDE"] ?? "claude-sonnet-5-5",
      chatgpt: env["ACP_MODEL_CHATGPT"] ?? "gpt-5-mini",
      gemini: env["ACP_MODEL_GEMINI"] ?? "gemini-2.5-flash",
      perplexity: env["ACP_MODEL_PERPLEXITY"] ?? "sonar",
    },
    githubRepos: (env["ACP_GITHUB_REPOS"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
