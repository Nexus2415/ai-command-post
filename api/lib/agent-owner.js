// Plain-JS copy of agentFor() in src/agents.ts. Vercel serves api/*.js without compiling TypeScript, so importing
// src/agents.ts from a function crashed it at load (HTTP 500). test/agent-owner.test.ts keeps the two identical.
export const MATCH = {
  claude: /\bclaude\b|anthropic/i,
  chatgpt: /chat\s*gpt|openai|\bgpt\b/i,
  gemini: /gemini/i,
  perplexity: /perplexity|sonar/i,
};
const LIST = Object.entries(MATCH);

/** Same rule as the dashboard: bracketed title prefix first, then labels, then assignee. */
export function agentFor(item) {
  const prefix = /^\s*\[([^\]]+)\]/.exec(item.title)?.[1];
  if (prefix) {
    const hit = LIST.find(([, re]) => re.test(prefix));
    if (hit) return hit[0];
  }
  const rest = [...(item.labels ?? []), item.assignee ?? ""].join(" | ");
  return LIST.find(([, re]) => re.test(rest))?.[0] ?? null;
}
