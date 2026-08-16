---
title: Projects
category: Organizations and access
order: 20
description: Group workspaces and apply settings to a group.
---

# Projects

A project groups workspaces inside an organization. Projects organize large organizations and apply settings to a group of workspaces at once.

## Create a project

Create a project from the projects page or the API. A project needs a name, unique within the organization. Projects can be nested under another project.

## What projects control

- Workspace organization and navigation.
- Variable set attachment by project.
- Policy set attachment by project.
- Project-level permissions for teams.
- Agent pool scoping.

## Workspaces in projects

A workspace belongs to exactly one project or none. When you create a workspace, choose its project. Workspaces without a project live at the organization level.

Moving a workspace between projects changes which project-scoped settings apply.

## Project permissions

Teams can be granted project-level permissions:

- Read access to the project and its workspaces.
- Management of workspaces in the project.
- Management of variable sets attached to the project.

## Deleting a project

Deleting a project has two options:

- Move the workspaces back to the organization level.
- Delete the workspaces with the project.

The second option removes all workspace data.

## API surface

- `GET /api/v2/organizations/:org_name/projects`
- `POST /api/v2/organizations/:org_name/projects`
- `PATCH /api/v2/projects/:id`
- `DELETE /api/v2/projects/:id`
- Team project permissions: `POST /api/v2/team-projects`
