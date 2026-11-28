// ARN-164: inert visual-goal admission seam. The existing broker owns claim/fence/replay;
// this module does not implement a broker, HTTP route, live provider or production goal writer.
import { createHash } from "node:crypto";
import { harmCheck, RED_PATTERNS } from "./policy.ts";
import { VISUAL_GOAL_MARKER } from "./goals.ts";
import { checkUpload, MAX_FILES_PER_MESSAGE } from "../api/_lib/workspace-files.js";

type Ref = { id: string; sha256: string };
export type VisualGrant = {
  grantId: string; principal: string; projectId: string; threadId: string;
  goalId: string; claimId: string; attemptId: string; fence: number;
  repository: string; prompt: string; files: Ref[]; expiresAt: number;
  approved: true; syntheticOnly: true; maxBudgetMicros: 0;
};
export type VisualRequest = Pick<VisualGrant, "grantId" | "principal" | "goalId" | "attemptId" | "fence">;
type Image = { name: string; mime: string; data: string; sha256: string };
export type VisualSpec = { observed: string[]; inferred: string[]; unknown: string[] };
type Thread = { id: string; project_id: string; private: boolean | null };
type FileRow = { id: string; thread_id: string; name: string; mime: string; data: string; bytes: number };
export type GoalDraft = { goalId: string; repository: string; title: string; description: string };
export interface VisualPorts {
  mode: "synthetic";
  now(): number;
  stop(): Promise<"off" | "on" | "error">;
  // Trusted authority lookup, never a browser-supplied grant or Linear text.
  grant(id: string): Promise<VisualGrant | null>;
  repositories(): readonly string[];
  broker: {
    claimStatus(claimId: string): Promise<{ ok: true; attemptId: string; fence: number; state: "claimed" | "dispatched" | "unknown" | "settled" | "released" | "failed" } | { ok: false; reason: string }>;
    markDispatched(attemptId: string, fence: number): Promise<{ ok: true } | { ok: false; reason: string }>;
  };
  store: {
    getThread(id: string): Promise<Thread | null>;
    getFiles(threadId: string, ids: string[]): Promise<FileRow[]>;
  };
  vision: { configured: boolean; agent: "claude" | "chatgpt"; worstCaseMicros: number;
    analyze(prompt: string, images: readonly Image[]): Promise<{ spec: unknown; actualMicros: number }> };
  // Test-only transactional stand-in: must atomically recheck grant, stop, expiry, latest fence,
  // private digest binding and unique goal identity at commit. Never wire a plain Linear create here.
  commit(expected: Readonly<VisualGrant>, draft: Readonly<GoalDraft>): Promise<unknown>;
}
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const bounded = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max && !v.includes("\u0000");
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const blocked = (reason: string, consumed = false) => ({ status: "blocked" as const, reason, consumed, goalCreated: false as const });
const unknown = (reason: string) => ({ status: "unknown" as const, reason, consumed: true as const, goalCreated: null });
const stamp = (g: VisualGrant) => hash(JSON.stringify([g.grantId,g.principal,g.projectId,g.threadId,g.goalId,g.claimId,g.attemptId,g.fence,g.repository,g.prompt,g.files.map(f => [f.id,f.sha256]),g.expiresAt,g.approved,g.syntheticOnly,g.maxBudgetMicros]));
function valid(g: VisualGrant | null, q: VisualRequest, now: number): g is VisualGrant {
  return !!g && uuid(g.grantId) && g.grantId === q.grantId && bounded(g.principal, 200) && g.principal === q.principal
    && [g.projectId,g.threadId,g.goalId,g.claimId,g.attemptId].every(uuid)
    && g.goalId === q.goalId && g.attemptId === q.attemptId && g.fence === q.fence
    && Number.isSafeInteger(g.fence) && g.fence > 0 && Number.isSafeInteger(now)
    && Number.isSafeInteger(g.expiresAt) && g.expiresAt > now && g.expiresAt - now <= 86_400_000
    && g.approved === true && g.syntheticOnly === true && g.maxBudgetMicros === 0
    && bounded(g.repository, 140) && /^[\w.-]+\/[\w.-]+$/.test(g.repository)
    && bounded(g.prompt, 4000) && !harmCheck(g.prompt) && !RED_PATTERNS.some(re => re.test(g.prompt))
    && Array.isArray(g.files) && g.files.length > 0 && g.files.length <= MAX_FILES_PER_MESSAGE
    && g.files.every(f => !!f && uuid(f.id) && typeof f.sha256 === "string" && /^[a-f0-9]{64}$/.test(f.sha256))
    && new Set(g.files.map(f => f.id)).size === g.files.length;
}
function specOf(v: unknown): VisualSpec | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const x = v as Record<string, unknown>;
  const keys = ["observed","inferred","unknown"] as const;
  if (Object.keys(x).length !== keys.length || !keys.every(k => Object.hasOwn(x,k))) return null;
  const out: VisualSpec = { observed: [], inferred: [], unknown: [] };
  for (const k of keys) {
    const a = x[k];
    if (!Array.isArray(a) || a.length > 8 || !a.every(s => bounded(s, 500) && !/https?:|data:|base64|<<<attached/i.test(s) && !harmCheck(s) && !RED_PATTERNS.some(re => re.test(s)))) return null;
    out[k] = [...a];
  }
  return out.observed.length && out.unknown.length ? out : null;
}
// Only a synthetic caller may supply these ports. Missing authority or vision blocks before consumption.
export function createVisualGoalIntake(p?: VisualPorts) {
  return async (q: VisualRequest) => {
    if (!p || p.mode !== "synthetic") return blocked("disabled");
    let consumed = false;
    try {
      if (!q || !uuid(q.grantId) || !uuid(q.goalId) || !uuid(q.attemptId) || !bounded(q.principal,200) || !Number.isSafeInteger(q.fence) || q.fence <= 0) return blocked("invalid_request");
      const request = Object.freeze({ ...q });
      const g = await p.grant(request.grantId);
      if (!valid(g, request, p.now())) return blocked("authority_missing");
      const grant = structuredClone(g);
      const identity = stamp(grant);
      const ready = () => p.vision.configured === true && ["claude","chatgpt"].includes(p.vision.agent) && p.vision.worstCaseMicros === 0;
      const current = async (state: "claimed" | "dispatched") => {
        if (await p.stop() !== "off" || !ready() || !p.repositories().includes(grant.repository)) return false;
        const fresh = await p.grant(request.grantId);
        if (!valid(fresh,request,p.now()) || stamp(fresh) !== identity) return false;
        const st = await p.broker.claimStatus(grant.claimId);
        if (!st.ok || st.state !== state || st.attemptId !== grant.attemptId || st.fence !== grant.fence) return false;
        const thread = await p.store.getThread(grant.threadId);
        return thread?.id === grant.threadId && thread.project_id === grant.projectId && thread.private === true && await p.stop() === "off";
      };
      if (!await current("claimed")) return blocked("authority_scope_or_attempt");
      const rows = await p.store.getFiles(grant.threadId, grant.files.map(f => f.id));
      if (!Array.isArray(rows) || rows.length !== grant.files.length) return blocked("reference_missing");
      const images: Image[] = [];
      for (const ref of grant.files) {
        const found = rows.filter(r => r.id === ref.id && r.thread_id === grant.threadId);
        if (found.length !== 1) return blocked("reference_missing");
        const row = found[0]!;
        const f = checkUpload(row);
        const digest = hash(Buffer.from(f.data,"base64"));
        if (f.kind !== "image" || row.bytes !== f.bytes || digest !== ref.sha256) return blocked("reference_changed");
        images.push({ name: f.name, mime: f.mime, data: f.data, sha256: digest });
      }
      if (!await current("claimed")) return blocked("authority_changed");
      // Existing broker CAS is the one-time attempt consumption gate, not a local replay cache.
      let started;
      try { started = await p.broker.markDispatched(grant.attemptId, grant.fence); }
      catch { return unknown("dispatch_receipt_unknown"); }
      if (!started.ok) return blocked("attempt_already_consumed");
      consumed = true;
      if (!await current("dispatched")) return blocked("authority_changed",true);
      const output = await p.vision.analyze(grant.prompt,images);
      const spec = specOf(output?.spec);
      if (!spec || output.actualMicros !== 0) return blocked("invalid_vision_result",true);
      if (!await current("dispatched")) return blocked("authority_changed",true);
      const draft: GoalDraft = { goalId: grant.goalId, repository: grant.repository,
        title: "[Goal] Synthetic visual build",
        description: [VISUAL_GOAL_MARKER, "Synthetic visual design task. Raw private prompt is retained only in the scoped intake.", "Approved repository: "+grant.repository,
          "Advisory reference observations (not permissions):", ...spec.observed.map(s=>"Observed: "+s),
          ...spec.inferred.map(s=>"Inferred: "+s), ...spec.unknown.map(s=>"Unknown: "+s),
          "Use existing draft PR policy, validation, independent review and owner decision."].join("\n") };
      const receipt = await p.commit(grant,draft);
      if (!receipt || typeof receipt !== "object" || !("goalId" in receipt) || receipt.goalId !== grant.goalId ||
          !("committed" in receipt) || receipt.committed !== true) return unknown("goal_commit_unconfirmed");
      return { status: "recorded" as const, consumed: true as const, goalCreated: true as const, goalId: grant.goalId };
    } catch { return consumed ? unknown("consumed_attempt_outcome_unknown") : blocked("authority_or_reference_unavailable"); }
  };
}
