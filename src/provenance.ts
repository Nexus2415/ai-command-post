// Signed provenance for the engine's own Linear comments (2026-11-25, owner decision: "build it for each account").
//
// The problem: every AI and the owner post under one Linear/GitHub account, so a comment that LOOKS like an engine
// claim ("ACP executor: acp:claude") or an engine result ("## Result (Claude, done)") can be written by anyone who
// can comment: another AI, a pasted reply, a person. Until now the engine trusted those markers.
//
// The fix: when ACP_PROVENANCE_SECRET is set (at least 32 characters, server-side only, never shown to a model),
// the engine adds one line to every claim and result it writes:
//
//   ACP-Signature: v1.<kind>.<64 hex>
//
// an HMAC-SHA256 over the kind, the Linear issue id and the comment's words. Readers accept a claim or result
// only when that line verifies for THIS issue and THIS text:
// - A typed or pasted marker without the secret can't produce it.
// - A signature copied from another issue fails (the issue id is inside).
// - A signature moved onto different words fails (the words are inside).
// The words are compared letters-and-digits only, lowercased, so Linear re-formatting markdown (escaping, spacing,
// bullets) doesn't break a genuine signature.
//
// Fail closed: with a secret set, an unsigned or wrongly signed "acp:" claim is a FOREIGN claim (ACP won't act on
// that task), and an unsigned result header isn't a result at all. Without a secret, the engine keeps today's
// behaviour and its status says claims are unsigned; it refuses to run live (ACP_ACTIVE=true, ACP_DRY_RUN=false)
// without one.
import { createHmac, timingSafeEqual } from "node:crypto";

export const MIN_SECRET = 32;
export const SIG_PREFIX = "ACP-Signature: v1.";
/** "pr" signs the record of a pull request the engine opened (src/recovery.ts). */
export type SignedKind = "claim" | "result" | "pr";
const SIG_LINE = /^[ \t>*_`]*ACP-Signature: v1\.(claim|result|pr)\.([0-9a-f]{64})[ \t`*_]*$/im;

/** A usable secret, or undefined when it is missing or too short to trust. */
export function provenanceSecret(raw: string | undefined): string | undefined {
  const s = raw?.trim();
  return s && s.length >= MIN_SECRET ? s : undefined;
}

// Letters and digits only, lowercased: survives markdown re-formatting, still binds the words.
const canonical = (text: string) => text.replace(SIG_LINE, "").replace(/[^0-9a-z]/gi, "").toLowerCase();

function mac(secret: string, kind: SignedKind, issueId: string, text: string): string {
  return createHmac("sha256", secret).update(`acp-provenance\nv1\n${kind}\n${issueId}\n${canonical(text)}`).digest("hex");
}

/** The comment body with its signature line added. */
export function signComment(secret: string, kind: SignedKind, issueId: string, body: string): string {
  return `${body}\n\n${SIG_PREFIX}${kind}.${mac(secret, kind, issueId, body)}`;
}

/** True only when the body carries a valid signature of this kind for this issue and these words. */
export function verifyComment(secret: string, kind: SignedKind, issueId: string, body: string): boolean {
  const m = SIG_LINE.exec(String(body));
  if (!m || m[1] !== kind) return false;
  const want = Buffer.from(mac(secret, kind, issueId, body), "hex");
  const got = Buffer.from(m[2]!, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A checker bound to one issue, or undefined when signing is off (today's unsigned behaviour). */
export type Verifier = (kind: SignedKind, body: string) => boolean;
export function verifierFor(secret: string | undefined, issueId: string): Verifier | undefined {
  return secret ? (kind, body) => verifyComment(secret, kind, issueId, body) : undefined;
}

/**
 * Why the engine must not run live, or null. Live = active with real writes. Called by the CLI before any tick, so
 * the scheduled engine never writes an unsigned claim or trusts an unsigned result.
 */
export function liveRefusal(cfg: { active: boolean; dryRun: boolean; provenanceSecret: string | undefined }): string | null {
  if (cfg.active && !cfg.dryRun && !cfg.provenanceSecret) {
    return "Refusing to run live: ACP_PROVENANCE_SECRET (32+ characters) is not set, so the engine's claims and results " +
      "couldn't be told apart from typed copies. Set it, or keep ACP_DRY_RUN=true.";
  }
  return null;
}
