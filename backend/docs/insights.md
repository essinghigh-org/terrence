---
title: Workspace and run insights
category: Workspaces and runs
order: 25
description: Compare retained evidence, review drift and investigate runs without bypassing the normal execution workflow.
---

# Workspace and run insights

Terrence exposes an **Insights** area for evidence and review workflows that sit beside the normal plan/apply lifecycle. Insights never create a second execution authority: comparisons are read-only, previews do not mutate infrastructure, and actions that need a Terraform run use the ordinary run pipeline and permissions.

## Workspace insights

Open **Workspace → Insights** for these views.

### State and resource history

State comparison compares two retained state versions. It reports additions, removals, changes, moves and output differences when both retained representations can be inspected.

The comparison is evidence about state stored by Terrence. It is **not** a live provider query and does not prove that cloud resources currently match either state. Client-encrypted or unavailable state can produce a limited comparison instead of an empty healthy result.

Resource history is derived from retained finalized state versions. Search can narrow the bounded retained observations by address or provider. Deleted or expired state cannot contribute evidence.

### Drift review

Health assessments can be recorded as drift incidents. An incident keeps review history, assignment, snooze state and explicit resolution evidence.

**Plan remediation** creates a normal `plan_and_apply` run with auto-apply disabled. The run passes through the same workspace lock, authorization, configuration selection, toolchain, provenance and idempotency checks as any other run. Review the resulting plan and policies before applying it.

Resolving an incident requires an explicit classification plus either subsequent assessment evidence or an acknowledged exception. Resolution does not claim that infrastructure was repaired.

### Access and sensitive-input impact

The access view shows the current request-time workspace permissions and ordinary grants contributing to them. It does not revoke previously issued signed capabilities.

Sensitive-input impact exposes variable names and references only. Secret values are never requested or displayed. Variable-set impact shows authorized consumers and recent planned runs so an operator can understand where a future variable change may be observed.

### Review tools

Review tools intentionally stop short of execution:

- **Import workbench** validates provider IDs and Terraform addresses and emits reviewed import blocks.
- **Engine upgrade review** records candidate engine/version metadata against retained evidence. It does not install or execute the candidate binary.
- **Dependency impact preview** evaluates explicitly supplied downstream workspace IDs; it is not automatic dependency discovery.
- **Adoption export** renders Terrence workspace configuration as HCL without credentials or sensitive values.

Use the ordinary run workflow after a review has produced acceptable evidence.

### Blueprints, policy packs and runbooks

Blueprints are previewable starting points rather than a provisioning engine. Policy packs describe advisory rules and their limitations. Runbooks link contextual Terrence documentation. None of these previews authorize an apply.

## Run insights

Each run page exposes **Insights & compare**.

### Compare plans

Terrence compares two retained public plan projections from the same workspace. The UI defaults to the latest earlier successful run of the same destroy/non-destroy kind when one exists in the recent run history.

Sensitive values are excluded. A removed resource means it disappeared from the compared public plan projection; it is not proof that a live resource was destroyed.

### Correlated timeline

The timeline combines retained run transitions, configuration ingress and audit events into chronological evidence. It is bounded retained history, not a complete distributed trace.

### Runbooks

Contextual runbooks point to product documentation that may help an operator investigate a run. They are references, not automated diagnosis or proof of root cause.

## API surface

Workspace evidence and review endpoints include:

- `POST /api/v2/workspaces/:workspace_id/state-comparisons`
- `GET /api/v2/workspaces/:workspace_id/inventory-history`
- `GET /api/v2/workspaces/:workspace_id/drift-incidents`
- `POST /api/v2/assessment-results/:assessment_result_id/drift-incident`
- `PATCH /api/v2/drift-incidents/:incident_id`
- `POST /api/v2/drift-incidents/:incident_id/remediation`
- `GET /api/v2/workspaces/:workspace_id/access-review`
- `GET /api/v2/workspaces/:workspace_id/secret-impact`
- `GET /api/v2/variable-sets/:variable_set_id/impact`
- `POST /api/v2/workspaces/:workspace_id/import-workbench`
- `POST /api/v2/workspaces/:workspace_id/upgrade-rehearsals`
- `POST /api/v2/workspaces/:workspace_id/dependency-impact-previews`
- `GET /api/v2/workspaces/:workspace_id/adoption-export`

Run evidence endpoints include:

- `POST /api/v2/runs/:run_id/plan-comparisons`
- `GET /api/v2/runs/:run_id/timeline`
- `GET /api/v2/runs/:run_id/runbooks`

Reference endpoints include:

- `GET /api/v2/workspace-blueprints`
- `POST /api/v2/workspace-blueprints/:blueprint_id/actions/preview`
- `GET /api/v2/policy-packs`
- `GET /api/v2/runbooks`
