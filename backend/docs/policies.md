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
| Advisory | Evaluated and reported. Never blocks. |
| Mandatory | A failure blocks the apply. |
| Soft mandatory | A failure blocks the apply unless an operator overrides it. |

Mandatory failures move the run to `errored` when the policy set is not overridable. Soft-mandatory failures move the run to `policy_soft_failed`, where an operator can override.

## Evaluation flow

1. The plan completes and plan JSON is produced.
2. The worker collects the policy sets for the workspace: workspace attachments, project attachments, global sets, minus exclusions.
3. Each policy evaluates against the plan JSON.
4. Results are stored per policy check with status, result, and address.
5. The run proceeds or stops according to the enforcement levels.

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
