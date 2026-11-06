---
title: Policies
category: Workspaces and runs
order: 50
description: Policy sets, enforcement levels, checks, and overrides.
---

# Policies

Policies enforce rules on plans before they apply. Terrence evaluates policy sets against the plan JSON after the plan completes.

## Policy sets

A policy set is a collection of policies. Policy sets attach to:

- An organization (global policy sets).
- A project.
- Specific workspaces.
- Workspace exclusions. An exclusion removes a workspace from an attached set.

A policy is a text file with a `main.sentinel` or a policy-as-code file that evaluates the plan. Policy evaluation uses the plan JSON structure.

## Enforcement levels

Each policy has an enforcement level:

| Level | Behavior |
|---|---|
| Advisory | A successfully evaluated policy denial is reported and does not block. |
| Mandatory | A failure blocks the apply. |
| Soft mandatory | A failure blocks the apply unless an operator overrides it. |

Mandatory denials block when the policy set is not overridable. Sentinel
soft-mandatory denials and denials in a policy set explicitly configured with
`overridable: true` move the run to `policy_soft_failed`, where an authorized operator can override them. An engine
execution error, missing policy source, malformed output, or incomplete
assessment is not a policy denial: it blocks even for advisory or overridable
policies, and cannot be overridden as if evaluation succeeded. OPA requires
its policy set to allow overrides explicitly; `overridable` defaults to false.

Site administrators can disable OPA or Sentinel enforcement independently
through [audited policy enforcement controls](administration#policy-enforcement).
Both engines enforce by default. A disabled engine is an intentional site-wide
bypass and is identified in the run log, not recorded as a policy passing.
The controls do not enable the unfinished `tfpolicy` runtime.

## Evaluation flow

1. The plan completes and plan JSON is produced.
2. The worker collects the policy sets for the workspace: workspace attachments, project attachments, global sets, minus exclusions.
3. Each policy evaluates against the plan JSON.
4. Results are stored per policy check with status, result, and address.
5. The run proceeds or stops according to the enforcement levels.
6. Before override or apply, Terrence verifies that the assessment is complete
   and still matches the policy source, attachments, parameters, tool versions,
   override permissions, and site enforcement revision. If any of these changed
   since evaluation, create a new plan. A client or execution agent cannot
   bypass this gate by reporting an unrelated successful result.

## Policy checks

Each run stores its policy checks. The run page shows the checks with pass, fail, and error counts. The result includes the evaluated policy output.

## Overrides

A soft-mandatory failure can be overridden. The override action moves the run back to `planned`. The web interface shows the override button on the run page.

## Policy set management

Policy sets are managed from the organization settings page. A policy set includes:

- Name and description.
- Policies.
- Attachments: workspaces, projects, global scope.
- Exclusions.
- Parameters passed to the policies.

Tagged policy sets can be attached by tag. See the policy set tags section in the web interface.

## Permissions

Policy management requires the `manage-policies` organization permission. Read access requires `read-policies`.

## API surface

- `GET /api/v2/organizations/:org_name/policy-sets`
- `POST /api/v2/organizations/:org_name/policy-sets`
- `PATCH /api/v2/policy-sets/:id`
- `DELETE /api/v2/policy-sets/:id`
- `GET /api/v2/policy-sets/:id/policies`
- `POST /api/v2/policy-sets/:id/policies`
- `POST /api/v2/runs/:id/actions/policy-override`
