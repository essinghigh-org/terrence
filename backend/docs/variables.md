---
title: Variables
category: Workspaces and runs
order: 30
description: Workspace variables, categories, sensitive values, and precedence.
---

# Variables

Workspace variables supply values to runs. Each workspace has its own variable set. Organization-level values live in variable sets instead. See [Variable sets](variable-sets).

## Categories

| Category | Purpose |
|---|---|
| Terraform | Input variables for the configuration. Passed to Terraform with the `-var` mechanism. |
| Environment | Variables exported to the run process. Available to providers and provisioners. |

A variable in the Terraform category has a key, a value, and optionally a description and an HCL flag. The HCL flag parses the value as HCL instead of a plain string. Use it for lists, maps, and objects.

Environment variables require an uppercase key.

## Sensitive values

Mark a variable sensitive at creation. The API returns `****` instead of the value after creation. The value is still delivered to runs.

Sensitive values are stored in the database. They are returned only in the creation response, before masking.

Changing a sensitive value marks the workspace as needing a new run. Terrence offers to queue a plan after variable changes.

## Precedence

When a workspace has both workspace variables and variable-set variables, workspace variables win for the same key. Variable sets are applied in order of their priority. Higher priority sets apply later and override earlier ones.

## Editing and deletion

Edit a variable to change its value. Deleting a variable removes it from future runs. Variable changes do not retroactively change past runs.

## Variable reads

Reading variable values requires the `read-variable` permission. The web interface shows values only to users with that permission.

## Runtime behavior

At run time, the worker collects:

- Workspace variables.
- Variable-set variables attached to the workspace, its project, and the organization.

The values are written into the run environment and passed to Terraform. Sensitive values are never written to the run log.

## API surface

- `GET /api/v2/workspaces/:id/vars`
- `POST /api/v2/workspaces/:id/vars`
- `PATCH /api/v2/workspaces/:id/vars/:var_id`
- `DELETE /api/v2/workspaces/:id/vars/:var_id`
