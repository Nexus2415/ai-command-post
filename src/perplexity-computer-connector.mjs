// ARN-64: deterministic research handoff envelope. NO outbound Computer execution.
// Inputs are untrusted. Provenance must be verified by an authenticated admission layer.
const ARN = /^ARN-[1-9][0-9]*$/;
const ID = /^[a-zA-Z0-9-]{1,100}$/;
const MAX_TEXT = 4000;
const REMOTE_EXECUTION_UNSUPPORTED = "No approved authenticated execution transport is configured for Perplexity Computer.";
const REQUIRED = ["issue", "taskText", "workspaceId", "projectId", "originCommentId", "assignmentRevision", "dataClassification", "acceptanceCriteria"];
export const PERPLEXITY_CONNECTION = Object.freeze({
  provider: "perplexity-computer",
  mode: "native-event-automation-not-configured",
  remoteExecutionReady: false,
  paidApiAuthorized: false,
});
export function makePerplexityHandoff(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, status: "invalid", reason: "Invalid task" };
  if (Object.keys(input).some(k => ![...REQUIRED, "eventReceiptId"].includes(k)))
    return { ok: false, status: "invalid", reason: "Unsupported task field" };
  const { issue, taskText, workspaceId, projectId, originCommentId, assignmentRevision, dataClassification, acceptanceCriteria, eventReceiptId } = input;
  if (typeof issue !== "string" || !ARN.test(issue) || typeof taskText !== "string" || !taskText.trim() || taskText.length > MAX_TEXT)
    return { ok: false, status: "invalid", reason: "Valid ARN issue and bounded task text required" };
  if (![workspaceId, projectId, originCommentId].every(v => typeof v === "string" && ID.test(v)) ||
      !Number.isSafeInteger(assignmentRevision) || assignmentRevision < 1 ||
      typeof acceptanceCriteria !== "string" || !acceptanceCriteria.trim() || acceptanceCriteria.length > 1000 ||
      (eventReceiptId !== undefined && (typeof eventReceiptId !== "string" || !ID.test(eventReceiptId))))
    return { ok: false, status: "invalid", reason: "Valid origin, revision and acceptance criteria required" };
  if (dataClassification !== "synthetic-or-public")
    return { ok: false, status: "refused", reason: "Unverified or client data cannot enter the AI handoff" };
  const link = "https://linear.app/arnexyia/issue/" + issue.toLowerCase();
  return {
    ok: true, schemaVersion: 1, status: "payload-packaged-not-admitted",
    provider: "perplexity-computer", issue, issueUrl: link,
    workspaceId, projectId, originCommentId, assignmentRevision,
    eventReceiptId: eventReceiptId ?? null,
    assignmentKey: [workspaceId, issue, originCommentId, assignmentRevision].join(":"),
    taskText, acceptanceCriteria,
    dataClassification, outputDestination: "same-linear-issue",
    instruction: "Verify the triggering issue, origin comment, revision and scope with authenticated Linear data. Only after durable admission and owner-approved native automation, research the exact taskText and acceptanceCriteria in this envelope. Record one sourced result in " + link + ". Sign — Perplexity Computer.",
    admitted: false, claimed: false, remoteExecutionReady: false,
    triggerTransport: "perplexity-native-linear-event-automation",
    requiredVerification: ["authenticated event provenance", "durable deduplication and claim", "owner-configured automation", "scoped Linear authorization", "real event-delivery test", "usage limits"],
  };
}
// This is not a claim store or authenticated event consumer; never start from this package.
export async function startPerplexityComputer(_handoff, _options = {}) {
  return { ok: false, status: "unsupported", retry: false, remoteExecutionReady: false, reason: REMOTE_EXECUTION_UNSUPPORTED };
}
