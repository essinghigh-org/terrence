---
title: Variable sets
category: Workspaces and runs
order: 40
description: Reuse variables across workspaces and projects with variable sets.
---

# Variable sets

A variable set is a named collection of variables that applies to many workspaces at once. Use variable sets for values that repeat across workspaces: shared account IDs, common endpoints, or standard environment settings.

## Where variable sets apply

A variable set can apply to:

- Workspaces, listed individually.
- Projects. Every workspace in the project receives the set.
- The whole organization. The set applies to every workspace.

The same set can attach to workspaces, projects, or both. The web interface shows the effective variable set for each workspace.

## Priorities

Each variable set has a priority. When several sets define the same key, the set with the higher priority wins. Workspace variables always win over variable-set variables.

Priorities are plain numbers. Assign deliberate gaps so later sets can slot between existing ones.

## Sensitive variables

Variable sets support sensitive values exactly like workspace variables. The API masks them after creation. See [Variables](variables).

## Editing

Editing a variable set changes the value for every workspace that uses it. Workspaces receive the new value at their next run.

Deleting a variable set removes its variables from all attached workspaces.

## Permissions

Managing variable sets requires the organization-level permission. The organization settings page lists all sets. Workspace users see the sets applied to their workspace.

## API surface

- `GET /api/v2/organizations/:org_name/variable-sets`
- `POST /api/v2/organizations/:org_name/variable-sets`
- `PATCH /api/v2/variable-sets/:id`
- `DELETE /api/v2/variable-sets/:id`
- `POST /api/v2/variable-sets/:id/relationships/workspaces`
- `POST /api/v2/variable-sets/:id/relationships/projects`
