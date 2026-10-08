// Read-only projections. "Assigned" does not mean a consumer AI session is online.
export const TEAM_ID = "faa75915-076f-479a-a3fb-92af2369e6c3";
export const PROJECT_ID = "e8cf8cda-3347-4310-aea5-e6b7c7b95b4f";
export const AGENTS = ["chatgpt", "claude", "gemini", "perplexity"];
export const LANES = ["active", "queued", "review", "blocked", "done", "canceled"];

export function safeLinearUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "linear.app" && !u.username && !u.password
      ? u.href : null;
  } catch { return null; }
}

export function ownerOf(title) {
  const m = /^\[(ChatGPT|Claude|Gemini|Perplexity)\](?:\s|$)/i.exec(String(title || ""));
  return m ? m[1].toLowerCase() : null;
}

export function laneOf(issue) {
  // Terminal state wins: canceled is NOT accomplished, even if a result says "done".
  const type = issue.state?.type;
  if (type === "completed") return "done";
  if (type === "canceled" || type === "duplicate") return "canceled";
  const labels = (issue.labels?.nodes || []).map(x => String(x.name).toLowerCase());
  const name = String(issue.state?.name || "").toLowerCase();
  if (/\bblocked\b/.test(name) || labels.includes("blocked")) return "blocked";
  if (/\breview\b/.test(name) || labels.includes("needs-review") || labels.includes("review")) return "review";
  if (type === "started") return "active";
  // Unrecognized state must never become a fabricated completion.
  return "queued";
}

export function projectIssue(issue) {
  return {
    id: issue.identifier, uuid: issue.id, title: issue.title || "",
    url: safeLinearUrl(issue.url), owner: ownerOf(issue.title),
    status: issue.state?.name || "Unknown", statusType: issue.state?.type || "unknown",
    lane: laneOf(issue), priority: Number.isInteger(issue.priority) ? issue.priority : 0,
    updatedAt: issue.updatedAt || null, completedAt: issue.completedAt || null,
    parent: issue.parent?.identifier || null,
    labels: (issue.labels?.nodes || []).map(x => x.name),
  };
}

export function overviewOf(nodes, fetchedAt, hasNextPage = false) {
  const issues = nodes.map(projectIssue);
  const lanes = Object.fromEntries(LANES.map(k => [k, issues.filter(i => i.lane === k).map(i => i.id)]));
  const agents = AGENTS.map(key => {
    const assigned = issues.filter(i => i.owner === key);
    const next = assigned.filter(i => i.lane === "queued")
      .sort((a, b) => (a.priority || 5) - (b.priority || 5) || a.id.localeCompare(b.id, undefined, { numeric: true }))[0];
    return {
      key, connection: "not_verified",
      // Observed Linear workload only, never a live heartbeat or model-provider claim.
      active: assigned.filter(i => i.lane === "active").map(i => i.id),
      queued: assigned.filter(i => i.lane === "queued").map(i => i.id),
      blocked: assigned.filter(i => i.lane === "blocked").map(i => i.id),
      review: assigned.filter(i => i.lane === "review").map(i => i.id),
      nextTask: next?.id || null,
    };
  });
  return { issues, lanes, agents, fetchedAt, hasNextPage,
    scope: { teamId: TEAM_ID, projectId: PROJECT_ID },
    evidence: { kind: "linear_snapshot", agentIdentity: "shared_account_not_authenticated" } };
}
