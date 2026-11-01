// Engine status: after each active run the engine rewrites one Linear project document, and /api/console reads it
// back for the dashboard's engine and budget panel. Anyone with Linear access can edit that document, so what is
// parsed here is display data only: it is validated, size-capped and never used to authorize anything.
export const STATUS_TITLE = "AI Command Post: engine status";
const AGENTS = ["claude", "chatgpt", "gemini", "perplexity"];
const COUNTS = ["planned", "worked", "reconciled", "waiting", "errors"];
const FENCE = /```json\n([^\n]{1,4000})\n```/;

export function statusContent(s) {
  const b = s.budget;
  return [
    "Written by the AI Command Post engine after each run. Don't edit it: the next run replaces it.",
    "",
    `- Last run: ${s.at}`,
    `- Mode: ${s.dryRun ? "dry run" : "live writes"}`,
    `- Spend ${b.month}: $${b.spentUsd.toFixed(4)} of $${b.capUsd.toFixed(2)} cap (${b.calls} calls)`,
    ...(b.ledgerProblem ? [`- Paid calls blocked: ${b.ledgerProblem}`] : []),
    "",
    "```json",
    JSON.stringify(s),
    "```",
  ].join("\n");
}

const iso = v => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const amount = v => typeof v === "number" && Number.isFinite(v) && v >= 0;
const count = v => Number.isInteger(v) && v >= 0;

/** The validated snapshot from a status document, or null when it is missing or malformed. */
export function parseStatus(content) {
  const m = FENCE.exec(typeof content === "string" ? content : "");
  if (!m) return null;
  let v;
  try { v = JSON.parse(m[1]); } catch { return null; }
  if (!v || v.version !== 1 || !iso(v.at) || typeof v.active !== "boolean" || typeof v.dryRun !== "boolean") return null;
  const b = v.budget;
  if (!b || typeof b.month !== "string" || !/^\d{4}-\d{2}$/.test(b.month) || !amount(b.spentUsd) || !amount(b.capUsd) || !count(b.calls)) return null;
  if (b.ledgerProblem != null && typeof b.ledgerProblem !== "string") return null;
  if (!Array.isArray(v.agentsOnline) || !v.counts || !COUNTS.every(k => count(v.counts[k]))) return null;
  return {
    at: v.at,
    active: v.active,
    dryRun: v.dryRun,
    lead: AGENTS.includes(v.lead) ? v.lead : null,
    agentsOnline: AGENTS.filter(a => v.agentsOnline.includes(a)),
    budget: { month: b.month, spentUsd: b.spentUsd, capUsd: b.capUsd, calls: b.calls, ledgerProblem: b.ledgerProblem ? b.ledgerProblem.slice(0, 200) : null },
    counts: Object.fromEntries(COUNTS.map(k => [k, v.counts[k]])),
  };
}

/** Picks the engine's document out of a project's documents (newest wins if someone duplicated it). */
export function engineStatusOf(documents) {
  const docs = (Array.isArray(documents) ? documents : []).filter(d => d && d.title === STATUS_TITLE);
  docs.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return docs.length ? parseStatus(docs[0].content) : null;
}

/**
 * The console's view of the engine report: "reported" with a validated snapshot, "absent" when the engine has
 * never written one, or "unavailable" when the documents can't be read or the engine's document is malformed.
 * Absent and unavailable differ: an unreadable report must never be shown as "not reported yet". Both absent and
 * reported need a complete list (hasNextPage === false): on a partial or unconfirmed list a missing match proves
 * nothing, and a match may be an older duplicate of a newer report on an unread page.
 */
export function engineStatusRead(documents, hasNextPage) {
  if (!Array.isArray(documents) || hasNextPage !== false) return { engineStatus: "unavailable", engine: null };
  if (!documents.some(d => d && d.title === STATUS_TITLE)) return { engineStatus: "absent", engine: null };
  const engine = engineStatusOf(documents);
  return engine ? { engineStatus: "reported", engine } : { engineStatus: "unavailable", engine: null };
}
