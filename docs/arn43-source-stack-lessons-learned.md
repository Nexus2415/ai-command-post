# ARN-43 source-stack lessons learned

Date recorded: 2026-10-14

## Scope

This note captures operational lessons from the ACP dependency-order source stack that moved through ARN-89, ARN-92, ARN-93 and ARN-94, plus the related opsdesk ARN-98 source merge.

This is documentation only. It does not authorize live dispatch, live JWKS trust, canonical Supabase migration, provider execution, client data, paid spend, secrets, flags, Stage 3, Limited Live, or any release-gate change.

## What completed

- ACP PR #42 / ARN-89 merged first as the disabled broker-adapter seam.
- ACP PR #43 / ARN-92 merged after non-destructive reconciliation onto current `main`.
- ACP PR #44 / ARN-93 merged after retargeting to `main` and cleaning the diff back to its intended authenticated-intake surface.
- ACP PR #45 / ARN-94 merged after retargeting to `main`, revalidating, and confirming that the current source tree matched the independently accepted reviewed head.
- opsdesk PR #191 / ARN-98 merged as the source-side broker-to-event lineage prerequisite.

## Highlights and lessons

### 1. Dependency order matters more than raw speed

The fastest safe path was not to merge every green PR at once. The correct order was:

1. merge the lower dependency;
2. retarget or reconcile the next stacked PR to `main`;
3. recheck mergeability, exact head and checks;
4. confirm the diff only contains that PR's intended scope;
5. only then call the next PR owner-merge-ready.

This avoided carrying stale or upstream changes into later source gates.

### 2. Green checks are necessary, not sufficient

Several PRs had passing CI or Ready Vercel previews before they were safe to merge. The useful acceptance packet was:

- PR open, not draft and mergeable;
- exact head SHA recorded;
- exact-head Validate or native workflow succeeded;
- independent review applied to that exact head or to an unchanged source tree;
- changed-file list matched the intended ARN scope;
- live gates remained explicitly blocked.

A passing check alone did not prove production readiness or release authorization.

### 3. Retargeting can leave a dirty diff

After PR #44 was retargeted to `main`, GitHub reported it as mergeable, but the changed-file list still included upstream ARN-92 files. That was a false sense of cleanliness.

The practical rule: after every retarget, inspect changed filenames. If upstream dependency files still appear, reconcile before owner merge.

### 4. Non-destructive reconciliation is the default

The stack touched a Lovable-connected repository. The safe reconciliation pattern was:

- do not force-push;
- do not rewrite pushed history;
- preserve the existing branch;
- add ordinary merge commits when needed;
- verify the final diff against `main`.

This preserved branch history while still clearing dependency drift.

### 5. Review applicability must be re-proven after reconciliation

When a branch was reconciled, prior reviews were not blindly reused. They were treated as applicable only after one of these was true:

- exact same head remained reviewed; or
- the latest merge commit changed no files relative to the reviewed implementation; or
- the diff was limited to dependency reconciliation and exact-head checks passed again.

This let us move quickly without pretending stale review evidence was stronger than it was.

### 6. Agent availability must not become a work stoppage

Claude hit a weekly limit and Codex implementation was unavailable until the repo environment was configured. The useful fallback was to keep the work narrow and mechanical:

- resolve only the named blocker;
- preserve prior implementation intent;
- avoid new feature work;
- document exact head, changed files, checks and blocked gates.

When an agent cannot execute, the coordinator can still perform reversible repository hygiene if it is source-only and owner-safe.

### 7. Wrong merges should be classified before reacting

A mistaken merge occurred on an older docs-only PR. The correct response was not panic rollback. It was classification:

- identify whether product/runtime code changed;
- identify whether secrets, flags, billing, database, provider calls or live workflows changed;
- if the merge is docs-only, note the stale guidance risk and correct later through normal docs flow.

This keeps recovery proportional to actual risk.

### 8. Synthetic success must stay labeled synthetic

ARN-94 produced useful native PostgreSQL evidence, restart evidence and signed synthetic event coverage, but it remained synthetic and disabled. The acceptance language must keep saying what is not proven:

- not canonical Supabase application;
- not live OIDC/JWKS trust;
- not deployed atomic intake;
- not customer or client authorization;
- not provider execution;
- not Stage 3 or Limited Live.

That wording prevents source progress from being mistaken for production authority.

### 9. File-list checks are a cheap safety gate

For fast-moving stacked work, `list_pr_changed_filenames` was one of the highest-value checks. It caught PR #44's polluted diff even though the PR was mergeable.

Add this to every stacked-PR readiness check:

```text
Changed files match intended ARN scope: yes/no
Unexpected upstream files present: yes/no
```

### 10. Merge-ready notices need exact coordinates

The owner can move faster when each merge-ready notice includes:

- repo;
- PR number;
- ARN;
- exact head SHA;
- current base or merge commit prerequisite;
- exact checks that passed;
- independent review basis;
- explicit non-authorizations.

This reduced back-and-forth and kept the owner from guessing which PR to merge.

## Recommended standing checklist for the next stack

Before asking Darius to merge a PR:

1. Read current `AGENTS.md` and the relevant issue or PR thread.
2. Confirm the PR is open, non-draft, mergeable and on the right base.
3. Record exact head SHA.
4. Confirm exact-head CI and any required native/special workflow succeeded.
5. Inspect changed filenames and compare them to the intended ARN scope.
6. Confirm independent review is exact-head or still applicable after reconciliation.
7. Confirm no secrets, flags, billing, live dispatch, production migration, client data, paid provider calls, Stage 3 or Limited Live changes are included.
8. State clearly whether merging may auto-deploy the production target.
9. Ask Darius to merge only the single dependency-order PR.
10. After the merge, immediately recheck the next stacked PR before declaring it ready.

## Open live gates after this source stack

The source stack advanced the ACP control-path evidence, but the following remain separate live gates:

- canonical Supabase project access and preflight;
- production-schema dry run and migration approval;
- live OIDC/JWKS trust verification;
- deployed atomic intake store with tenant role/RLS mapping;
- live kill-drill and recovery evidence;
- authenticated owner journey evidence;
- provider DPA/commercial authorization where required;
- client authorization and consent path;
- Stage 3 and Limited Live owner approval.

## Operating decision

For the next work sprint, prioritize live-readiness blockers and evidence reconciliation over broad docs polish or speculative features. Keep the hallway narrow: exact dependency order, source-only unless explicitly owner-approved, and no live authority changes without Darius.