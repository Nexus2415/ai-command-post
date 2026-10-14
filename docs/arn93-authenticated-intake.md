# ARN-93 source-only authenticated intake

The new intake has no HTTP route, default key store, database connection,
credentials, environment reads or worker dispatch. It is disabled by default;
the only supported injected mode is synthetic. The existing Eve HTTP dispatch
handler remains unsupported. Tests use real RSA signatures over synthetic data.

The boundary verifies RS256 with the configured issuer's trusted public key,
issuer/audience/exact subject, stable team/project IDs, environment and times.
Vercel workload identity does not grant application tenant, executor or role.
Only server policy supplies the permitted tenants and approved zero-cost shadow
action. The recording port is intake-only and must atomically recheck authority,
deadline and kill state, deduplicate immutable event identity, and commit audit.
Its typed acknowledgment confirms recording, never business completion.

Owner gates before any live wiring: verify deployed issuer mode and JWKS
rotation/availability; authorize the exact ACP project/environment/stable IDs;
verify tenant and intake/caller/verifier role mapping at the canonical database;
inspect canonical migration state and RLS/ACLs; reconcile reviewed stacked source;
prove kill/rollback; then separately authorize configuration and activation.
Offline key signatures and synthetic JWT GUCs do not establish these live gates.
No client authorization is inferred from an internal owner test.

ARN-94 must exercise this boundary and the approved manager/broker/persistence
seams against disposable native SQL, including server restart. Command keys use
the full `tenant:task:review_result` identity required by manager SQL; the older
raw ARN-89 adapter uses a different key convention and must not be blindly wired.
