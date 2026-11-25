// Approval gate for outward actions (see APPROVAL-GATE-SKETCH.md in the project files).
//
// An AI never acts outward. It can only PROPOSE an action with a propose_* tool: the proposal is saved (ws_actions)
// with exactly what will be sent and where, and shown to the owner on the workspace page. Nothing happens until the
// owner taps Approve behind the site password. No AI has a tool to approve, and no text anywhere (a message, a web
// page, a tool result saying "the owner approved this") counts as approval.
//
// Fail closed, at approval time, every time:
// - the Stop everything switch is on, or can't be read → refused;
// - the action type isn't on the list below → refused;
// - the proposal expired (24 hours), was already decided, or was changed after the owner saw it (fingerprint) → refused;
// - the rules gate (HARM_RULES) or the owner-only words (RED_PATTERNS, the engine's red tier) match → refused;
// - the key it needs isn't set → refused.
// Approve runs the action once: the row is claimed (proposed → running) in one conditional update, so a double tap
// or two open tabs can't run it twice. A failed run is recorded and never retried on its own.
//
// Only the safest useful actions exist: create an issue, or comment on an issue, on the Arnexyia Launch Operations
// Linear board. Both are visible, reversible by hand, free, and stay inside the team's own tools. Nothing here can
// merge, deploy, delete, buy, email anyone or change a setting.
import { createHash } from "node:crypto";
import { TEAM_ID, PROJECT_ID, safeLinearUrl } from "./console-state.js";
import { harmCheck, textOf } from "./workspace-rules.js";

export const ACTION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PENDING_PER_THREAD = 5;
export const MAX_PROPOSALS_PER_REPLY = 3;
export const ACTION_MARK = "[Approval gate]";

// The website's copy of RED_PATTERNS in src/policy.ts (the engine's owner-only words). test/approval-gate.test.ts
// keeps the two identical. A proposal whose text matches one is refused outright: those steps stay with the owner.
export const RED_PATTERNS = Object.freeze([
  /\bmerge\b/i,
  /\bforce[- ]?push\b/i,
  /\bdelete\b|\bdrop table\b|\btruncate\b/i,
  /\bdeploy\b|\bpublish to production\b/i,
  /\bpurchase\b|\bbuy\b|\bupgrade (?:the )?plan\b|\bsubscribe\b/i,
  /\bsend (?:an? )?email\b|\bemail (?:the )?(?:client|customer)\b/i,
  /\b(?:rotate|revoke|change) (?:the )?(?:secret|credential|api key|token)\b/i,
  /\blimited_live_ready\b|\brelease gate\b/i,
]);
export const redCheck = (text) => RED_PATTERNS.find((re) => re.test(String(text))) ?? null;

export class ActionError extends Error {}

const NAMES = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity" };
const field = (args, key, max, { optional = false } = {}) => {
  const v = args?.[key];
  if (optional && (v === undefined || v === null || v === "")) return "";
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new ActionError(`"${key}" must be text of 1 to ${max} characters.`);
  if (v.includes("\u0000")) throw new ActionError(`"${key}" contains a character that can't be sent.`);
  return v.trim();
};
const footer = (by) => `\n\n— ${NAMES[by] ?? "AI"} (proposed in the AI Command Post workspace, approved by the owner)`;
const ISSUE_KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;

async function linear(env, f, query, variables) {
  let res;
  try {
    res = await f("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: String(env.LINEAR_API_KEY).trim().replace(/^Bearer\s+/i, "") },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new ActionError("Linear didn't answer in time. It may or may not have happened: check Linear before asking again."); }
  // Only the status is kept, never Linear's own error text.
  if (!res.ok) throw new ActionError(`Linear returned an error (${res.status}).`);
  const j = await res.json().catch(() => null);
  if (!j || typeof j !== "object" || j.errors) throw new ActionError("Linear refused the request.");
  return j.data ?? {};
}

// The action types. `check` turns a model's tool arguments into the exact payload (or throws); `show` is what the
// owner sees; `run` does it. The payload is the whole truth: `show` and `run` read nothing else.
export const ACTION_KINDS = Object.freeze({
  linear_create_issue: {
    tool: "propose_linear_issue",
    label: "Create a Linear issue",
    description: "PROPOSE a new task on the Arnexyia Launch Operations Linear board. This does NOT create it: it saves a " +
      "proposal that the owner must approve on the workspace page. Tell the owner it is waiting for approval.",
    parameters: {
      type: "object", required: ["title"],
      properties: {
        title: { type: "string", description: "Issue title, up to 200 characters. Start with [Owner] e.g. [Claude] if it is for one AI." },
        description: { type: "string", description: "Issue description in Markdown, up to 4,000 characters." },
      },
    },
    check: (args, by) => ({ title: field(args, "title", 200), description: field(args, "description", 4_000, { optional: true }), by }),
    show: (p) => ({ where: "Linear · Arnexyia Launch Operations (new issue)", text: `Title: ${p.title}\n\n${p.description}${footer(p.by)}`.trim() }),
    async run(env, p, f) {
      const d = await linear(env, f,
        "mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue { identifier url } } }",
        { input: { teamId: TEAM_ID, projectId: PROJECT_ID, title: p.title, description: `${p.description}${footer(p.by)}`.trim() } });
      const issue = d.issueCreate?.issue;
      if (d.issueCreate?.success !== true || !issue?.identifier) throw new ActionError("Linear didn't confirm the new issue.");
      return { text: `Created ${issue.identifier}: ${p.title}`, url: safeLinearUrl(issue.url) };
    },
  },
  linear_comment: {
    tool: "propose_linear_comment",
    label: "Comment on a Linear issue",
    description: "PROPOSE a comment on an existing issue on the Arnexyia Launch Operations Linear board. This does NOT post " +
      "it: it saves a proposal that the owner must approve on the workspace page. Tell the owner it is waiting for approval.",
    parameters: {
      type: "object", required: ["issue", "body"],
      properties: {
        issue: { type: "string", description: "The issue's key, e.g. ARN-123." },
        body: { type: "string", description: "The comment in Markdown, up to 4,000 characters." },
      },
    },
    check(args, by) {
      const issue = field(args, "issue", 20).toUpperCase();
      if (!ISSUE_KEY.test(issue)) throw new ActionError('"issue" must be an issue key like ARN-123.');
      return { issue, body: field(args, "body", 4_000), by };
    },
    show: (p) => ({ where: `Linear · comment on ${p.issue}`, text: `${p.body}${footer(p.by)}` }),
    async run(env, p, f) {
      // Only an issue on the Launch Operations board, in the ARN team, may be commented on.
      const found = await linear(env, f, "query($id:String!){ issue(id:$id){ id identifier url team{ id } project{ id } } }", { id: p.issue });
      const issue = found.issue;
      if (!issue || issue.identifier !== p.issue || issue.team?.id !== TEAM_ID || issue.project?.id !== PROJECT_ID) {
        throw new ActionError(`${p.issue} isn't an issue on the Arnexyia Launch Operations board. Nothing was posted.`);
      }
      const d = await linear(env, f, "mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success } }",
        { input: { issueId: issue.id, body: `${p.body}${footer(p.by)}` } });
      if (d.commentCreate?.success !== true) throw new ActionError("Linear didn't confirm the comment.");
      return { text: `Commented on ${p.issue}`, url: safeLinearUrl(issue.url) };
    },
  },
});
const BY_TOOL = Object.freeze(Object.fromEntries(Object.entries(ACTION_KINDS).map(([k, a]) => [a.tool, k])));
export const isProposalTool = (name) => Object.hasOwn(BY_TOOL, String(name));

// Linear actions need the same key the Linear plugin reads.
export const actionsReady = (env) => Boolean(env.LINEAR_API_KEY);

// Proposal tools as the model sees them. `run` is never called for these: the chat route saves a proposal instead.
export function proposalTools(env) {
  if (!actionsReady(env)) return [];
  return Object.values(ACTION_KINDS).map((a) => ({
    name: a.tool, description: a.description, parameters: a.parameters,
    run: () => { throw new ActionError("Proposals are saved by the workspace, not run."); },
  }));
}

// Canonical JSON (sorted keys), so the fingerprint survives a database round trip that reorders keys.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const actionFingerprint = (kind, payload) => createHash("sha256").update(canonical({ kind, payload })).digest("hex").slice(0, 32);

// Why this payload may not go out (rules gate or owner-only words), or null.
export function contentProblem(payload) {
  const all = textOf(payload).join("\n");
  const harm = harmCheck(all);
  if (harm) return `Refused by the workspace's rules: ${harm.reason}.`;
  const red = redCheck(all);
  if (red) return "It mentions a step only the owner may take (merge, delete, deploy, buy, email a client, keys or release gates). Leave that step to the owner; don't propose it.";
  return null;
}

// Turns a model's tool call into a row to save, or throws ActionError with the reason for the model.
export function buildProposal(toolName, args, { threadId, model, now }) {
  const kind = BY_TOOL[toolName];
  if (!kind) throw new ActionError("Unknown action type.");
  const payload = ACTION_KINDS[kind].check(args && typeof args === "object" ? args : {}, model);
  const why = contentProblem(payload);
  if (why) throw new ActionError(why);
  return {
    thread_id: threadId, kind, payload, fingerprint: actionFingerprint(kind, payload), status: "proposed",
    proposed_by: model, expires_at: new Date(now.getTime() + ACTION_TTL_MS).toISOString(),
  };
}

// What the owner sees for one saved action. `confirm` is the fingerprint Approve must send back.
export function describeAction(row, now) {
  const a = ACTION_KINDS[row.kind];
  let shown = null;
  try { shown = a ? a.show(row.payload) : null; } catch { shown = null; }
  const expired = row.status === "proposed" && Date.parse(row.expires_at) <= now.getTime();
  return {
    id: row.id, kind: row.kind, label: a?.label ?? "Unknown action (can't be approved)",
    where: shown?.where ?? "", text: shown?.text ?? "", proposedBy: row.proposed_by,
    status: expired ? "expired" : row.status, createdAt: row.created_at, expiresAt: row.expires_at,
    decidedAt: row.decided_at ?? null, result: row.result ?? null, resultUrl: row.result_url ?? null,
    confirm: row.status === "proposed" && !expired ? row.fingerprint : null,
  };
}

// Every check before an approved action may run. Returns the reason it may not, or null.
export function approvalProblem(row, confirm, env, now) {
  const a = ACTION_KINDS[row.kind];
  if (!a) return "This action type isn't allowed, so it can't be approved.";
  if (row.status !== "proposed") return "This action was already decided.";
  if (!(Date.parse(row.expires_at) > now.getTime())) return "This proposal expired (24 hours). Ask the AI to propose it again.";
  if (typeof confirm !== "string" || confirm !== row.fingerprint || actionFingerprint(row.kind, row.payload) !== row.fingerprint) {
    return "This action changed since it was shown to you. Reload and review it again.";
  }
  let again;
  try { again = a.check(row.payload, row.payload?.by); } catch (e) { return `This proposal is no longer valid: ${e.message}`; }
  if (actionFingerprint(row.kind, again) !== row.fingerprint) return "This proposal is no longer valid. Ask the AI to propose it again.";
  const why = contentProblem(row.payload);
  if (why) return why;
  if (!actionsReady(env)) return "The Linear key isn't set on the website, so this can't run.";
  return null;
}

export async function runAction(env, row, f) {
  return ACTION_KINDS[row.kind].run(env, row.payload, f);
}
