# Platform workflow projections

Terrence exposes bounded, reviewable projections for state history, plans, fleet selection, dependency impact, drift, import mapping, promotions, upgrade rehearsals, and policy experiments. These endpoints share the existing `durable_jobs` retention surface. Their rows are records for the API and are not claimed by the worker queue.

Every projection is scoped through the existing workspace or organization permission checks. A missing, cross-organization, expired, or revoked object is returned as a not-found response. Payloads are canonicalized and capped at 512 KiB before persistence. Sensitive values are masked; opaque or client-encrypted state returns a limited comparison. A comparison proves a difference between retained Terrence artifacts only. It does not prove a live cloud change.

## Comparison and inventory

- `POST /api/v2/workspaces/:workspace_id/state-comparisons` compares two retained state-version IDs. It reports resource additions, removals, updates, moves, output changes, digests, and whether the result is detailed or limited.
- `POST /api/v2/runs/:run_id/plan-comparisons` compares two runs from the same workspace using their retained public plan projections. Raw plans and sensitive values are never returned.
- `GET /api/v2/workspaces/:workspace_id/inventory-history` returns resource observations derived from finalized retained state versions. `q` or `address` filters the projection; it is not a live provider inventory query.

## Review workflows

- `POST /api/v2/organizations/:org_name/fleet-operations/previews` materializes an immutable target manifest. Fleet execution returns HTTP 501 until an executor is implemented; it does not consume the preview or report target success.
- `POST /api/v2/workspaces/:workspace_id/dependency-impact-previews` records bounded dependency edges and detected cycles. Queueing the preview preserves the input graph and does not apply a workspace.
- `POST /api/v2/workspaces/:workspace_id/import-workbench` validates provider IDs and addresses, emits import blocks, reports existing-ID conflicts, and preserves unresolved arguments for review. It has no apply authority.
- `POST /api/v2/organizations/:org_name/promotions` creates an ordered promotion graph. `.../:promotion_id/advance` returns HTTP 501 until configuration digest binding and stage completion checks are implemented. `.../stop` records an explicit stop; it does not mutate the workspace.
- `POST /api/v2/workspaces/:workspace_id/upgrade-rehearsals` validates a candidate engine/version against a retained baseline and records a speculative-plan review. Rehearsal promotion is rejected until an explicit workspace configuration change is made.
- `POST /api/v2/organizations/:org_name/policy-playground` validates an OPA or Sentinel source against a supplied plan projection. Results are review-only and never authorize apply.

Use the normal plan/apply endpoints after a review result has been accepted and an explicit configuration or workspace change has been made. These projections are deliberately evidence and orchestration records, not a second execution authority.
