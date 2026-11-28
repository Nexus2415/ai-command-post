# ARN-164 visual build intake

This draft implements the private, server-checked preview slice only. It makes no model call, creates no Linear goal and does not dispatch. The existing `ACP_GITHUB_REPOS` is read, never changed; no new settings or permissions.

## Remaining binding

The current workspace file store is private to the workspace and its API; the engine's `[Goal]` planner consumes Linear text. Neither an image hash nor a browser preview is an authorization grant. Do not put image bytes, private attachment IDs, prompts or public URLs in Linear to bridge this gap. Before enabling Start, add a durable, atomic authorization/consumption path binding the authenticated principal, workspace project/thread, allowed repository, goal ID, exact attempt/fence, image digests, approval, expiry, budget and stop state. Resolve the bytes only under that binding. Reject replay, changed references, stale attempts and absent vision capability. Use the existing planner and claim/review gates; no new paid call or provider. Add synthetic end-to-end proof through draft PR validation and independent review. This document does not authorize activation or schema rollout.
