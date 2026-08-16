---
title: Provider sets
category: Registry and VCS
order: 15
description: Restrict which provider versions a workspace may use.
---

# Provider sets

A provider set selects the provider versions a workspace may use. Provider sets add control over the supply chain of a run.

## How provider sets work

1. An organization creates provider sets.
2. Each set pins a provider version or a version range.
3. Workspaces attach to the sets.
4. At run time, the worker resolves the provider from the attached sets.

A provider version outside every attached set is refused. The run fails with a clear error.

## Version selection

A provider set holds:

- The provider namespace and name.
- A version or version constraint.
- An optional priority.

When several sets apply to one workspace, the highest-priority matching set wins.

## Tags

Provider sets can target workspaces by tag. A set with tag scoping applies to workspaces carrying the tag.

## Management

Provider sets are managed from the organization settings:

- Create a set for a provider version.
- Attach workspaces or tags.
- Remove a set.

The workspace settings page shows which provider sets apply.

## API surface

- `GET /api/v2/organizations/:org_name/provider-sets`
- `POST /api/v2/organizations/:org_name/provider-sets`
- `PATCH /api/v2/provider-sets/:id`
- `DELETE /api/v2/provider-sets/:id`
- `POST /api/v2/provider-sets/:id/relationships/workspaces`
