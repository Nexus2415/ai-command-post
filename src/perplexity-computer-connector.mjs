// ARN-64: Perplexity Computer handoff connector. No remote Computer execution API is verified.
// Intentionally does not import fetch, call providers, or handle credentials.
const ARN = /^ARN-[1-9][0-9]*$/;
const MAX_TEXT = 4000;
const REMOTE_EXECUTION_UNSUPPORTED = "No supported, authenticated remote Perplexity Computer execution trigger has been verified.";
export const PERPLEXITY_CONNECTION = Object.freeze({
  provider: "perplexity-computer",
  mode: "manual-handoff-only",
  remoteExecutionReady: false,
  paidApiAuthorized: false,
});

export function makePerplexityHandoff(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, status: "invalid", reason: "Invalid task" };
  const issue = String(input.issue || "");
  const text = input.text;
  if (!ARN.test(issue) || typeof text !== "string" || !text.trim() || text.length > MAX_TEXT)
    return { ok: false, status: "invalid", reason: "Valid ARN issue and bounded task text required" };
  if (input.dataClassification !== "synthetic-or-public")
    return { ok: false, status: "refused", reason: "Unverified or client data cannot enter the AI handoff" };
  const link = "https://linear.app/arnexyia/issue/" + issue.toLowerCase();
  return {
    ok: true,
    status: "awaiting-manual-start",
    provider: "perplexity-computer",
    issue,
    issueUrl: link,
    instruction: "Open " + link + ". Read the current issue and comments; execute only its bounded public/synthetic research task, then post one sourced result in the same issue. Sign — Perplexity Computer.",
    remoteExecutionReady: false,
  };
}

// A deliberately explicit boundary so downstream code cannot mistake packaging for execution.
export async function startPerplexityComputer(_handoff, options = {}) {
  void options;
  return { ok: false, status: "unsupported", retry: false, remoteExecutionReady: false, reason: REMOTE_EXECUTION_UNSUPPORTED };
}
