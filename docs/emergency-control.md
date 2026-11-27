# ARN-137 independent emergency boundary (source-only)

This draft provides a durable latch and generation-fenced worker entry contract; it is not an activated emergency switch. The existing manager kill switch and workspace controls remain unchanged.

## Intended separation

- Independent database and access credentials, not the workspace service role, app administrator, worker or model.
- Reader: only read the current latch; never write it.
- Containment operator: escalate AEGIS or BLACKOUT; cannot recover.
- Owner: authorize recovery against the exact current generation and provide a verified recovery evidence reference.
- Database provisioning/ownership belongs to a separate trusted infrastructure operator. Verify role memberships, grants, TLS, backups, retention and no application access to the database-owner role before any activation. No credentials in this repository.

The latch starts BLACKOUT, survives repeated schema application, records transitions, refuses stale recovery and treats every new containment request as a new generation. AEGIS prevents new execution; BLACKOUT must additionally independently revoke execution access and isolate workers/network. The TypeScript gate refuses missing, malformed, stale and unavailable state, invalidates old permits on recovery and treats a changed control state after a call as an unknown outcome. It does not cancel in-flight calls or prove external containment. Manager claims and broker fences are still required for idempotency; the generation permit alone is not a one-time worker token.

## Acceptance still required before live

1. Owner-approved independent infrastructure and separated principals; live authoritative read, not a cached UI value.
2. Integrate the reader into the durable manager's dispatch path and all external tool boundaries without bypassing the existing kill switch.
3. A separate containment actuator with authenticated evidence for cancellation, credential disablement, blocked network, scheduler stop and no automatic restart. Do not confuse a stored BLACKOUT state with completed isolation.
4. Exercise service outage, in-flight interruption, process restart, stale read, compromised app principal, stale recovery and owner-only resumption in isolated fixtures before considering live controls.
5. Independent exact-head review and owner authorization for any deployment, role grant or recovery.

No production settings, deployment, schema, worker activation or spend are authorized by this document.
