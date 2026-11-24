// ARN-136: inert budget execution seam. No production route is wired to this module.
import { isId, StoreError, workspaceConfigured } from "./workspace-store.js";

const micros = (v) => Number.isSafeInteger(v) && v >= 0;
const admitted = "reserved";
const refused = new Set(["invalid", "isolation_unsupported", "ledger_unavailable",
  "duplicate", "unknown_thread", "stopped", "ceiling_violation", "monthly_cap", "thread_cap"]);

// Use only with the isolated workspace service credential, never the client database.
// RPC errors and unexpected shapes are not equivalent to a negative/zero balance.
export function createWorkspaceBudgetPort(env, f = fetch) {
  if (!workspaceConfigured(env)) throw new StoreError("Workspace budget storage unavailable");
  const base = new URL("/rest/v1/rpc/", env.ACP_WORKSPACE_DB_URL);
  const key = String(env.ACP_WORKSPACE_DB_KEY).trim();
  if (!key) throw new StoreError("Workspace budget storage unavailable");
  async function rpc(name, args) {
    const res = await f(new URL(name, base).href, {
      method: "POST",
      headers: { apikey: key, authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify(args), signal: AbortSignal.timeout(15_000), redirect: "error",
    });
    if (!res.ok) throw new StoreError("Workspace budget RPC unavailable");
    const rows = await res.json().catch(() => null);
    if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.decision !== "string")
      throw new StoreError("Workspace budget RPC returned invalid data");
    return rows[0].decision;
  }
  return {
    reserve: (p) => rpc("ws_budget_reserve", { p_request: p.requestId, p_thread: p.threadId,
      p_micros: p.maximumMicros, p_month_cap: p.monthCapMicros, p_thread_cap: p.threadCapMicros }),
    settle: (p, actual) => rpc("ws_budget_settle", { p_request: p.requestId, p_thread: p.threadId, p_actual: actual }),
  };
}

// Trusted caller supplies a stable operation ID, independently established upper price
// bound, caps, final control check and receipt verifier. Never feed browser/model input
// directly into these ports. Unknown outcomes deliberately retain the full hold.
// This is not an authenticated receipt implementation or provider tariff registry.
export async function executeReserved(port, plan, { beforeDispatch, dispatch, verifyReceipt }) {
  const { requestId, threadId, maximumMicros, monthCapMicros, threadCapMicros } = plan ?? {};
  if (!isId(requestId) || !isId(threadId) || !micros(maximumMicros) || maximumMicros === 0 ||
      !micros(monthCapMicros) || !micros(threadCapMicros) ||
      typeof beforeDispatch !== "function" || typeof dispatch !== "function" || typeof verifyReceipt !== "function")
    return { status: "refused", reason: "invalid_plan" };
  if (maximumMicros > monthCapMicros || maximumMicros > threadCapMicros)
    return { status: "refused", reason: "cap" };
  // Immutable snapshot: callbacks cannot change the operation identity or monetary bounds.
  const p = Object.freeze({ requestId, threadId, maximumMicros, monthCapMicros, threadCapMicros });
  let decision;
  try { decision = await port.reserve(p); }
  catch { return { status: "unknown", reason: "reservation_unavailable" }; }
  if (decision !== admitted) return refused.has(decision)
    ? { status: "refused", reason: decision }
    : { status: "unknown", reason: "reservation_unavailable" };
  try {
    if (await beforeDispatch(p) !== true) return { status: "unknown", reason: "dispatch_refused_hold_retained" };
    const receipt = await dispatch(p);
    const verified = await verifyReceipt(receipt, p);
    if (!verified || verified.requestId !== p.requestId || verified.threadId !== p.threadId ||
        !micros(verified.actualMicros))
      return { status: "unknown", reason: "receipt_unverified" };
    const actual = verified.actualMicros;
    const settled = await port.settle(p, actual);
    if (actual > p.maximumMicros || settled === "ceiling_violation")
      return { status: "blocked", reason: "ceiling_violation" };
    if (settled !== "settled" && settled !== "already_settled")
      return { status: "unknown", reason: "settlement_unconfirmed" };
    return { status: "settled", actualMicros: actual };
  } catch {
    return { status: "unknown", reason: "execution_or_settlement_unconfirmed" };
  }
}
