import type { AgentKey } from "./config.ts";

export interface AgentProfile {
  key: AgentKey;
  name: string;
  role: string;
  /** Matches the name in a title prefix, label or assignee. Must stay in sync with the dashboard. */
  match: RegExp;
  /** Tools this agent may use. The policy layer still checks every call. */
  tools: string[];
}

export const AGENTS: Record<AgentKey, AgentProfile> = {
  claude: {
    key: "claude",
    name: "Claude",
    role: "Engineering, architecture, code review and security-sensitive technical work.",
    match: /\bclaude\b|anthropic/i,
    tools: ["github.read_file", "github.list_tree", "github.search_issues", "github.open_pull_request", "linear.comment", "firecrawl.scrape", "vercel.list_deployments", "vercel.deployment_status"],
  },
  chatgpt: {
    key: "chatgpt",
    name: "ChatGPT",
    role: "Coordination, planning, writing and reconciliation of other agents' findings.",
    match: /chat\s*gpt|openai|\bgpt\b/i,
    tools: ["linear.comment", "firecrawl.search", "firecrawl.scrape", "github.read_file", "vercel.list_deployments", "vercel.deployment_status"],
  },
  gemini: {
    key: "gemini",
    name: "Gemini",
    role: "Google ecosystem expertise and independent challenge of other agents' conclusions.",
    match: /gemini/i,
    tools: ["linear.comment", "firecrawl.search", "firecrawl.scrape", "github.read_file", "vercel.list_deployments", "vercel.deployment_status"],
  },
  perplexity: {
    key: "perplexity",
    name: "Perplexity",
    role: "Current web research with cited sources.",
    match: /perplexity|sonar/i,
    tools: ["linear.comment", "firecrawl.search", "firecrawl.scrape"],
  },
};

export const AGENT_LIST = Object.values(AGENTS);

export interface OwnedItem {
  title: string;
  labels?: string[];
  assignee?: string | null;
}

/** Same rule as the dashboard: bracketed title prefix first, then labels, then assignee. */
export function agentFor(item: OwnedItem): AgentKey | null {
  const prefix = /^\s*\[([^\]]+)\]/.exec(item.title)?.[1];
  if (prefix) {
    const hit = AGENT_LIST.find((a) => a.match.test(prefix));
    if (hit) return hit.key;
  }
  const rest = [...(item.labels ?? []), item.assignee ?? ""].join(" | ");
  return AGENT_LIST.find((a) => a.match.test(rest))?.key ?? null;
}

export function titleFor(agent: AgentKey, title: string): string {
  const clean = title.replace(/^\s*\[[^\]]+\]\s*/, "").trim();
  return `[${AGENTS[agent].name}] ${clean}`;
}
