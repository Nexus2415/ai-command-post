// ARN-164: read-only visual build intake preview. No model, goal creation or execution authority.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readSession } from "./site-auth.js";
import { redCheck } from "./workspace-actions.js";
import { checkUpload, FileProblem, MAX_FILES_PER_MESSAGE } from "./workspace-files.js";
import { isId } from "./workspace-store.js";
import { harmCheck } from "./workspace-rules.js";

const fail = (status, error) => ({ status, body: { error } });
const repoPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/;
export function buildRepositories(env) {
  return [...new Set(String(env.ACP_GITHUB_REPOS ?? "").split(",").map(s => s.trim())
    .filter(s => repoPattern.test(s) && ![".", ".."].includes(s.split("/")[1])))].sort();
}

// All inputs are untrusted. The authoritative thread/project and scoped bytes are read from the
// existing workspace store; a preview is not a capability, approval, durable goal or attempt.
export async function visualBuildPreview(store, args, env) {
  const fields = ["threadId", "projectId", "repository", "content", "files", "syntheticOnly"];
  if (Object.keys(args).some(k => !fields.includes(k))) return fail(400, "Unknown build input.");
  if (!isId(args.threadId) || !isId(args.projectId)) return fail(400, "Choose a project and thread.");
  if (args.syntheticOnly !== true) return fail(400, "Use synthetic references only; confirm before previewing.");
  if (typeof args.repository !== "string" || !buildRepositories(env).includes(args.repository))
    return fail(403, "Repository is not on the existing engine allowlist.");
  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (!content || content.length > 4000) return fail(400, "Describe the build in 1–4000 characters.");
  if (harmCheck(content) || redCheck(content)) return fail(422, "Refused by the workspace rules gate or owner-only action policy.");
  if (/https?:|data:|base64|<<<attached/i.test(content)) return fail(400, "Use a synthetic build description, not URLs or encoded attachments.");
  if (!Array.isArray(args.files) || !args.files.length || args.files.length > MAX_FILES_PER_MESSAGE ||
      !args.files.every(isId) || new Set(args.files.map(id => id.toLowerCase())).size !== args.files.length)
    return fail(400, "Attach one to three distinct images in this thread.");
  const stopped = async () => {
    try { return (await store.getControl())?.stopped !== false; } catch { return true; }
  };
  if (await stopped()) return fail(423, "Stop everything is on or unavailable.");
  const thread = await store.getThread(args.threadId);
  if (!thread || thread.id !== args.threadId || thread.project_id !== args.projectId || thread.private !== true)
    return fail(403, "Build references require a verified private thread in the selected project.");
  const rows = await store.getFiles(thread.id, args.files);
  if (!Array.isArray(rows) || rows.length !== args.files.length) return fail(404, "A reference is missing from this thread.");
  const references = [];
  for (const id of args.files) {
    const matches = rows.filter(r => r.id === id && r.thread_id === thread.id);
    if (matches.length !== 1) return fail(404, "A reference is missing from this thread.");
    try {
      const f = checkUpload(matches[0]);
      if (f.kind !== "image" || f.bytes !== matches[0].bytes) return fail(400, "Only verified image references are accepted.");
      references.push({ name: f.name, mime: f.mime, bytes: f.bytes, sha256: createHash("sha256").update(Buffer.from(f.data, "base64")).digest("hex") });
    } catch (e) {
      if (e instanceof FileProblem) return fail(400, "Invalid reference image.");
      throw e;
    }
  }
  // Repeat the privacy/stop reads after loading attachments. No preview authorizes future execution.
  const current = await store.getThread(thread.id);
  if (current?.id !== thread.id || current?.project_id !== thread.project_id || current?.private !== true)
    return fail(403, "Thread scope changed; preview again in a verified private thread.");
  if (await stopped()) return fail(423, "Stop everything is on or unavailable.");
  return {
    preview: {
      repository: args.repository, content, references,
      observed: ["Reference file type, byte count and SHA-256 checked against this private thread."],
      inferred: [],
      unknown: ["Image contents have not been analyzed by a vision model.", "Goal, approval and attempt binding are not yet available."],
      acceptance: ["Review intended scope and image interpretation.", "Use only the approved repository and draft pull requests.", "Pass validation and independent review before owner merge."],
      modelCalled: false, goalCreated: false, dispatchAvailable: false, costUsd: 0,
    },
  };
}

const SCOPE_TTL = 15 * 60_000;
const sha = v => createHash("sha256").update(v).digest("hex");
const hmac = (env, purpose, value) => createHmac("sha256", env.ACP_SITE_PASSWORD).update(purpose + "\u0000" + value).digest("hex");
const HEX = /^[a-f0-9]{64}$/;
const equal = (a,b) => typeof a === "string" && typeof b === "string" && HEX.test(a) && HEX.test(b)
  && timingSafeEqual(Buffer.from(a,"hex"),Buffer.from(b,"hex"));

// A password header alone is not a named owner approval. The existing configured owner email
// and signed browser session must agree. No email/password is stored in the scope record.
export function buildOwner(req, env, now) {
  const owner = typeof env.ACP_OWNER_EMAIL === "string" ? env.ACP_OWNER_EMAIL.trim().toLowerCase() : "";
  const s = readSession(req,env,now);
  return owner && s && s.email.toLowerCase() === owner && s.exp * 1000 > now
    ? { principal: hmac(env,"acp-build-owner-v1",owner), expiresAt:s.exp*1000 } : null;
}
const manifestFor = (args,p) => ({projectId:args.projectId,threadId:args.threadId,repository:p.repository,content:p.content,
  files:p.references.map((r,i)=>({id:args.files[i],name:r.name,mime:r.mime,bytes:r.bytes,sha256:r.sha256}))});
const signTicket = (env,principal,id,expiresAt,fingerprint) => hmac(env,"acp-build-scope-v1",JSON.stringify([principal,id,expiresAt,fingerprint]));
export async function previewWithTicket(store,args,env,owner,now) {
  const out=await visualBuildPreview(store,args,env);
  if (!out.preview || !owner) return out;
  const id=randomUUID(), expiresAt=Math.min(now+SCOPE_TTL,owner.expiresAt);
  const fingerprint=sha(JSON.stringify(manifestFor(args,out.preview)));
  return {...out, scopeTicket:{id,expiresAt,signature:signTicket(env,owner.principal,id,expiresAt,fingerprint)}};
}

// Saves only the exact reviewed scope, not a grant to call an AI, create a Linear issue or dispatch.
// The database RPC serializes scope storage against thread privacy, file changes and stop state.
export async function saveVisualScope(store,args,env,owner,now) {
  if (!owner) return fail(403,"A configured owner browser session is required to save scope.");
  const {ticket,...input}=args;
  if (!ticket || Object.keys(ticket).sort().join(",") !== "expiresAt,id,signature" || !isId(ticket.id) ||
    !Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt <= now || ticket.expiresAt > now+SCOPE_TTL ||
    ticket.expiresAt > owner.expiresAt || !HEX.test(String(ticket.signature))) return fail(409,"Scope preview expired or invalid. Preview again.");
  const out=await visualBuildPreview(store,input,env);
  if (!out.preview) return out;
  const manifest=manifestFor(input,out.preview), fingerprint=sha(JSON.stringify(manifest));
  if (!equal(ticket.signature,signTicket(env,owner.principal,ticket.id,ticket.expiresAt,fingerprint)))
    return fail(409,"Scope changed since preview. Review again.");
  let r;
  try { r=await store.saveBuildScope({p_id:ticket.id,p_principal:owner.principal,p_manifest:manifest,
    p_expires_at:new Date(ticket.expiresAt).toISOString(),p_fingerprint:fingerprint}); }
  catch { return fail(503,"Scope storage is unavailable or unconfirmed. Retry the same preview; nothing will dispatch."); }
  if (r?.scope_id!==ticket.id || !["saved","already_saved"].includes(r.outcome))
    return fail(409,"Scope could not be saved. Review the current private thread and preview again.");
  return {scope:{id:r.scope_id,state:"scope_saved",dispatchAvailable:false,goalCreated:false,costUsd:0}};
}
