// ARN-93: inert synthetic intake. No route, credentials, transport or live wiring.
// Workload identity is verified cryptographically; application authority comes
// from a separate trusted policy lookup. This never dispatches a worker.
import { constants, verify, type KeyObject } from "node:crypto";

export interface WorkloadTrust {
  issuer: string; audience: string; subject: string;
  ownerId: string; projectId: string; environment: string;
  tenantIds: readonly string[];
}
export interface IntakeEvent {
  tenantId: string; eventId: string; taskId: string;
  seq: number; occurredAt: string;
}
export interface IntakeApproval {
  tenantId: string; taskId: string; intent: "review_result";
  actionRef: string; approvalRef: string; expiresAt: number;
  approved: true; mode: "shadow"; maxBudgetMicros: 0;
  // Distinct from the Gmail-only owner_internal_test provenance (opsdesk 0018); see opsdesk 0035 intake_grants.
  authorizationBasis: "owner_intake_grant";
}
export interface IntakeCommand {
  event: Readonly<IntakeEvent>; claimKey: string; idempotencyKey: string;
  approval: Readonly<IntakeApproval>; validUntil: number;
  scope: Readonly<{ role: "broker_intake"; executor: "acp"; tenantId: string; subject: string }>;
}
export interface IntakeReceipt {
  ok: true; committed: true; created: boolean; commandId: string;
  tenantId: string; eventId: string; taskId: string; seq: number;
  claimKey: string; idempotencyKey: string; actionRef: string; approvalRef: string;
  // Server binding: the verified workload subject, the grant that authorized it and the stored deadline.
  subject: string; grantId: string; validUntil: number;
}
export interface IntakeDeps {
  mode: "synthetic"; trust: WorkloadTrust;
  // Only the configured issuer's trusted key store; never token jku/x5u/iss.
  key(kid: string): Promise<KeyObject | null>;
  now(): number; kill(): "off" | "on" | "error";
  approval(event: Readonly<IntakeEvent>): Promise<IntakeApproval | null>;
  // MUST atomically enforce validUntil, authority and immutable event replay,
  // write command + audit, then confirm commit. A process cache is insufficient.
  record(command: Readonly<IntakeCommand>): Promise<unknown>;
}
type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const text = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const whole = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const blocked = (reason: string) => ({ status: "blocked" as const, sent: false as const, reason });
const eventKeys = ["tenantId", "eventId", "taskId", "seq", "occurredAt"];
function event(v: unknown): v is IntakeEvent {
  return obj(v) && Object.keys(v).length === eventKeys.length && eventKeys.every(k => k in v)
    && uuid(v["tenantId"]) && text(v["eventId"]) && text(v["taskId"], 100)
    && whole(v["seq"]) && text(v["occurredAt"], 50) && Number.isFinite(Date.parse(v["occurredAt"]));
}
function decode(part: string): Obj {
  const bytes = Buffer.from(part, "base64url");
  if (bytes.toString("base64url") !== part) throw new Error("noncanonical JWT");
  const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!obj(v)) throw new Error("invalid JWT object");
  return v;
}
function receipt(v: unknown, c: IntakeCommand): v is IntakeReceipt {
  const keys = ["ok", "committed", "created", "commandId", "tenantId", "eventId", "taskId", "seq", "claimKey", "idempotencyKey", "actionRef", "approvalRef", "subject", "grantId", "validUntil"];
  return obj(v) && Object.keys(v).length === keys.length && keys.every(k => k in v)
    && v["ok"] === true && v["committed"] === true && typeof v["created"] === "boolean"
    && uuid(v["commandId"]) && v["tenantId"] === c.event.tenantId && v["eventId"] === c.event.eventId
    && v["taskId"] === c.event.taskId && v["seq"] === c.event.seq && v["claimKey"] === c.claimKey
    && v["idempotencyKey"] === c.idempotencyKey && v["actionRef"] === c.approval.actionRef
    && v["approvalRef"] === c.approval.approvalRef
    && v["subject"] === c.scope.subject && uuid(v["grantId"])
    && whole(v["validUntil"]) && v["validUntil"] <= c.validUntil;
}

/** Default disabled; the existing HTTP dispatch handler remains unsupported. */
export function createAuthenticatedIntake(deps?: IntakeDeps) {
  const trust = deps ? Object.freeze({ ...deps.trust, tenantIds: Object.freeze([...deps.trust.tenantIds]) }) : null;
  return async (token: unknown, input: unknown) => {
    if (!deps || deps.mode !== "synthetic" || !trust) return blocked("disabled");
    try {
      if (!/^https:\/\/oidc\.vercel\.com(?:\/[a-z0-9-]+)?$/.test(trust.issuer)
        || !text(trust.audience) || !text(trust.subject) || !text(trust.ownerId)
        || !text(trust.projectId) || !["preview", "production"].includes(trust.environment)
        || !trust.tenantIds.length || !trust.tenantIds.every(uuid)) return blocked("unconfigured_trust");
      if (deps.kill() !== "off") return blocked("kill_switch");
      if (!event(input)) return blocked("invalid_event");
      const e = Object.freeze({ ...input });
      if (!trust.tenantIds.includes(e.tenantId)) return blocked("forbidden_tenant");
      if (typeof token !== "string" || token.length > 8192) return blocked("invalid_token");
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return blocked("invalid_token");
      const header = decode(parts[0]!);
      if (header["alg"] !== "RS256" || header["typ"] !== "JWT" || !text(header["kid"], 128)
        || Object.keys(header).some(k => !["alg", "typ", "kid"].includes(k))) return blocked("invalid_header");
      const key = await deps.key(header["kid"]);
      if (!key || key.type !== "public" || key.asymmetricKeyType !== "rsa"
        || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return blocked("unknown_key");
      if (!verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`),
        { key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(parts[2]!, "base64url"))) return blocked("bad_signature");
      const claims = decode(parts[1]!);
      const aud = Array.isArray(claims["aud"]) ? claims["aud"] : [claims["aud"]];
      if (claims["iss"] !== trust.issuer || claims["sub"] !== trust.subject
        || !aud.length || !aud.every(a => text(a)) || !aud.includes(trust.audience)
        || claims["owner_id"] !== trust.ownerId || claims["project_id"] !== trust.projectId
        || claims["environment"] !== trust.environment) return blocked("wrong_principal");
      // Vercel workload tokens do not grant application roles or tenants.
      if (["tenant_ids", "executor", "role", "permissions"].some(k => k in claims)) return blocked("spoofed_authority");
      const now = deps.now();
      const exp = claims["exp"], iat = claims["iat"], nbf = claims["nbf"];
      if (!whole(now) || !whole(exp) || !whole(iat) || !whole(nbf)
        || exp <= now || iat > now || nbf > now || exp <= iat || exp - iat > 7200) return blocked("invalid_time");
      const age = now * 1000 - Date.parse(e.occurredAt);
      if (age < -300000 || age > 86400000) return blocked("stale_event");
      const a = await deps.approval(e);
      if (!a || a.tenantId !== e.tenantId || a.taskId !== e.taskId || a.intent !== "review_result"
        || !uuid(a.actionRef) || !uuid(a.approvalRef) || !whole(a.expiresAt) || a.approved !== true
        || a.mode !== "shadow" || a.maxBudgetMicros !== 0 || a.authorizationBasis !== "owner_intake_grant") return blocked("approval_required");
      const validUntil = Math.min(exp, a.expiresAt);
      const beforeRecord = deps.now();
      if (deps.kill() !== "off" || !whole(beforeRecord) || beforeRecord >= validUntil) return blocked("authority_expired_or_killed");
      const c: IntakeCommand = Object.freeze({ event: e,
        claimKey: `${e.tenantId}:${e.taskId}:review_result`, idempotencyKey: `${e.tenantId}:${e.eventId}`,
        approval: Object.freeze({ tenantId: a.tenantId, taskId: a.taskId, intent: a.intent,
          actionRef: a.actionRef, approvalRef: a.approvalRef, expiresAt: a.expiresAt,
          approved: a.approved, mode: a.mode, maxBudgetMicros: a.maxBudgetMicros,
          authorizationBasis: a.authorizationBasis }), validUntil,
        scope: Object.freeze({ role: "broker_intake", executor: "acp", tenantId: e.tenantId, subject: trust.subject }) });
      const r = await deps.record(c);
      if (!receipt(r, c)) return blocked("unconfirmed_record");
      // The store has committed. Past the stored deadline or under the kill switch the caller must not act on it,
      // but this is not a refusal either. After a kill switch lifts, identical replay recovers the same receipt; past
      // the deadline it cannot (authority has expired), so that case needs a read-only receipt lookup (not built).
      const afterRecord = deps.now();
      if (deps.kill() !== "off" || !whole(afterRecord) || afterRecord >= r.validUntil) return blocked("committed_after_deadline");
      return { status: "recorded" as const, sent: false as const, receipt: Object.freeze({ ...r }), command: c };
    } catch { return blocked("intake_unavailable"); }
  };
}
