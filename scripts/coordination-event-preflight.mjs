// ARN-63: inert, evidence-only preflight; no API clients or side effects.
import { readFileSync } from "node:fs";

export function classifyEvent(event, repo, actor) {
  if (repo !== "Nexus2415/ai-command-post" || actor !== "Nexus2415") return { accepted: false, reason: "untrusted-origin" };
  if (!event || event.action !== "created" || !event.comment || !event.issue) return { accepted: false, reason: "unsupported-event" };
  if (event.comment.user?.login !== "Nexus2415") return { accepted: false, reason: "untrusted-comment-author" };
  const body = String(event.comment.body || "");
  const match = /^\/arnexyia handoff (ARN-\d+) (claude|codex|perplexity|gemini)$/i.exec(body.trim());
  if (!match) return { accepted: false, reason: "not-explicit-handoff" };
  return { accepted: true, issue: match[1].toUpperCase(), agent: match[2].toLowerCase(), action: "record-only" };
}

if (process.argv[1]?.endsWith("coordination-event-preflight.mjs")) {
  let event;
  try { event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")); }
  catch { event = null; }
  const outcome = classifyEvent(event, process.env.GITHUB_REPOSITORY, process.env.GITHUB_ACTOR);
  console.log(JSON.stringify(outcome));
  // Rejected events are intentional no-ops; never dispatch an AI or write an issue.
}
