// ARN-45: strict unwrapping of the opsdesk 0035 intake RPC results into the shapes IntakeDeps expects.
// Pure functions: no route, credentials or transport. Anything not exactly the documented shape is null,
// so a caller wiring them into IntakeDeps fails closed (approval_required / unconfirmed_record).
import type { IntakeApproval, IntakeReceipt } from "./authenticated-intake.ts";

type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Obj, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

const RECEIPT_OUTER = ["ok", "created", "receipt", "subject", "grantId", "validUntil"] as const;
const RECEIPT_INNER = ["ok", "committed", "created", "commandId", "tenantId", "eventId", "taskId", "seq",
  "claimKey", "idempotencyKey", "actionRef", "approvalRef"] as const;
const APPROVAL_OUTER = ["ok", "approval"] as const;
const APPROVAL_INNER = ["tenantId", "taskId", "intent", "actionRef", "approvalRef", "expiresAt", "approved",
  "mode", "maxBudgetMicros", "authorizationBasis"] as const;

/** broker_record_intake → IntakeDeps.record result. The values are re-checked against the command by the intake. */
export function intakeReceiptFromRpc(v: unknown): IntakeReceipt | null {
  if (!obj(v) || !exact(v, RECEIPT_OUTER) || v["ok"] !== true || typeof v["created"] !== "boolean") return null;
  const r = v["receipt"];
  if (!obj(r) || !exact(r, RECEIPT_INNER) || r["ok"] !== true || r["committed"] !== true) return null;
  // The outer and nested created flags describe one commit; a disagreement means the result can't be trusted.
  if (r["created"] !== v["created"]) return null;
  return { ...r, subject: v["subject"], grantId: v["grantId"], validUntil: v["validUntil"] } as IntakeReceipt;
}

/** broker_read_intake_grant → IntakeDeps.approval result. The values are re-checked by the intake. */
export function intakeApprovalFromRpc(v: unknown): IntakeApproval | null {
  if (!obj(v) || !exact(v, APPROVAL_OUTER) || v["ok"] !== true) return null;
  const a = v["approval"];
  if (!obj(a) || !exact(a, APPROVAL_INNER)) return null;
  return { ...a } as unknown as IntakeApproval;
}
