/**
 * Authority tiers. The engine enforces these in code; a model's instructions cannot change them.
 *
 * GREEN  — reversible, internal: read code, search the web, comment on a task.
 * YELLOW — visible but reviewable: open a pull request, create a sub-task. Allowed only when enabled in config.
 * RED    — irreversible, spends money, or reaches outside: merge, delete, deploy, purchase, send email,
 *          change credentials or release flags. Never executed; the engine asks the owner instead.
 */
export type Tier = "green" | "yellow" | "red";

export const TOOL_TIERS: Record<string, Tier> = {
  "github.read_file": "green",
  "github.list_tree": "green",
  "github.search_issues": "green",
  "firecrawl.search": "green",
  "firecrawl.scrape": "green",
  "linear.comment": "green",
  "linear.create_subtask": "yellow",
  "github.open_pull_request": "yellow",
};

/** Words that mark a requested action as owner-only no matter which tool is asked for. */
const RED_PATTERNS: RegExp[] = [
  /\bmerge\b/i,
  /\bforce[- ]?push\b/i,
  /\bdelete\b|\bdrop table\b|\btruncate\b/i,
  /\bdeploy\b|\bpublish to production\b/i,
  /\bpurchase\b|\bbuy\b|\bupgrade (?:the )?plan\b|\bsubscribe\b/i,
  /\bsend (?:an? )?email\b|\bemail (?:the )?(?:client|customer)\b/i,
  /\b(?:rotate|revoke|change) (?:the )?(?:secret|credential|api key|token)\b/i,
  /\blimited_live_ready\b|\brelease gate\b/i,
];

export interface PolicyContext {
  allowPullRequests: boolean;
  allowedRepos: string[];
}

export type Decision = { allow: true; tier: Tier } | { allow: false; tier: Tier; reason: string };

export function decide(tool: string, input: Record<string, unknown>, ctx: PolicyContext): Decision {
  const tier = TOOL_TIERS[tool];
  if (!tier) return { allow: false, tier: "red", reason: `Unknown tool "${tool}" is blocked` };

  const text = JSON.stringify(input);
  // Only free-text intent fields are scanned; a file path containing "delete" is fine.
  const intent = [input["title"], input["body"], input["message"], input["intent"]].filter((v) => typeof v === "string").join(" ");
  const red = RED_PATTERNS.find((re) => re.test(intent));
  if (red) return { allow: false, tier: "red", reason: `Owner approval required: request matches "${red.source}"` };

  if (tool.startsWith("github.")) {
    const repo = input["repo"];
    if (typeof repo !== "string" || !ctx.allowedRepos.includes(repo)) {
      return { allow: false, tier, reason: `Repo ${String(repo)} is not in ACP_GITHUB_REPOS` };
    }
  }
  if (tool === "github.open_pull_request" && !ctx.allowPullRequests) {
    return { allow: false, tier, reason: "Opening pull requests is disabled (ACP_ALLOW_PULL_REQUESTS=false)" };
  }
  if (text.length > 200_000) return { allow: false, tier, reason: "Tool input too large" };
  return { allow: true, tier };
}
