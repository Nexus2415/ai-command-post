// Read-only command lifecycle (ARN-71). Derived only from scoped Linear evidence: issue state, comments and
// sub-issues. "Issue created" never implies "AI executed"; anything the evidence can't support reads as
// "Execution not verified" or "unknown". Comments are posted from a shared account, so a marker is a recorded
// claim, never proof that an AI is online.

// Plain-JS mirrors of the engine markers in src/orchestrator.ts (Vercel can't import .ts at runtime).
export const COMMAND_MARKER = "Command issued from AI Command Post";
export const RESULT_MARKER = "## Result";
export const SUMMARY_MARKER = "## Command summary";
const EXECUTOR_RE = /^ACP executor:\s*(\S+)/m;
const LEGACY_CLAIM_RE = /^Claimed by (.+?) \(AI Command Post\)/;
const RESULT_RE = /^\s*## Result \(([^,)]+),\s*(done|blocked)\)/;

const NOT_VERIFIED = "Execution not verified. This page can't see whether the engine is switched on or whether any AI picked this up.";

const at = c => { const t = Date.parse(c?.createdAt || ""); return Number.isNaN(t) ? Infinity : t; };
const byTime = list => [...list].sort((a, b) => at(a) - at(b) || String(a.id).localeCompare(String(b.id)));

export function isCommand(issue) {
  return String(issue?.description || "").includes(COMMAND_MARKER);
}

/**
 * issue: projected issue fields plus description and state; comments: [{ id, body, createdAt }];
 * children: [{ identifier, state: { type } }] or null when unknown.
 * Returns { stage, label, detail, evidence: [{ kind, commentId?, issue? }] }.
 */
export function lifecycleOf(issue, comments, children) {
  if (/^\s*\[question\]/i.test(issue?.title || "")) {
    return { stage: "question", label: "Question · read-only", detail: "Owner questions are never executable work.", evidence: [] };
  }
  if (!isCommand(issue)) return null;
  if (!Array.isArray(comments)) return unknown("Comments couldn't be read.");
  const type = issue?.state?.type;
  const sorted = byTime(comments);
  const summary = sorted.find(c => String(c.body || "").trimStart().startsWith(SUMMARY_MARKER));
  const results = sorted.filter(c => RESULT_RE.test(String(c.body || "")));
  const blockedResult = [...results].reverse().find(c => RESULT_RE.exec(c.body)[2] === "blocked");
  const doneResult = summary || [...results].reverse().find(c => RESULT_RE.exec(c.body)[2] === "done");
  const claim = sorted.find(c => EXECUTOR_RE.test(String(c.body || "")) || LEGACY_CLAIM_RE.test(String(c.body || "")));
  const ref = c => ({ kind: "comment", commentId: c.id });

  if (type === "canceled" || type === "duplicate") {
    return { stage: "canceled", label: "Canceled", detail: "Canceled in Linear. Canceled is not done.", evidence: blockedResult ? [ref(blockedResult)] : [] };
  }
  if (type === "completed") {
    if (!doneResult) return unknown("Marked done in Linear, but no recorded result was found.");
    if (blockedResult && at(blockedResult) > at(doneResult)) return unknown("Marked done, but the latest recorded result says blocked.");
    return { stage: "completed", label: "Completed", detail: "Done in Linear with a recorded result.", evidence: [ref(doneResult)] };
  }
  if (doneResult) return unknown("A result is recorded, but the issue isn't closed in Linear.");
  const name = String(issue?.state?.name || "").toLowerCase();
  const labels = (issue?.labels || []).map(l => String(l).toLowerCase());
  if (blockedResult || /\bblocked\b/.test(name) || labels.includes("blocked")) {
    return { stage: "blocked", label: "Blocked",
      detail: blockedResult ? "A blocked result is recorded; open it for the reason." : "Marked blocked in Linear; no reason was recorded.",
      evidence: blockedResult ? [ref(blockedResult)] : [] };
  }
  const open = Array.isArray(children) ? children.filter(c => !["completed", "canceled", "duplicate"].includes(c?.state?.type)) : [];
  if (claim) {
    return { stage: "claimed", label: "Claimed",
      detail: "A claim comment is recorded" + (open.length ? " and " + open.length + " sub-task(s) are open" : "") +
        ". It was posted from a shared account, so it doesn't prove the AI is running now.",
      evidence: [ref(claim), ...open.map(c => ({ kind: "issue", issue: c.identifier }))] };
  }
  if (type === "started") return unknown("In progress in Linear, but no claim is recorded.");
  return { stage: "queued", label: "Issue created · not picked up", detail: NOT_VERIFIED, evidence: [] };
}

function unknown(why) {
  return { stage: "unknown", label: "Unknown", detail: why + " " + NOT_VERIFIED, evidence: [] };
}
