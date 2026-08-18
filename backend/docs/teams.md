---
title: Teams and permissions
category: Organizations and access
order: 30
description: The permission model: organization roles, teams, workspace access, and project access.
---

# Teams and permissions

Terrence follows the Terraform access model: users get access through organization memberships and teams, and teams get permissions on workspaces and projects.

## Organization roles

Every organization membership carries one role:

| Role | Grants |
|---|---|
| Owner | Everything, including deletion. |
| Member | Baseline access. |
| Custom role | A defined subset of permissions. |

The organization settings page manages roles. Custom roles select from the full permission list: workspace management, policy management, VCS settings, agent pools, and more.

## Teams

A team is a group of users inside an organization. Teams exist for granting the same access to several users at once.

The owner team has full access. The "Everyone" team contains every organization member by default and grants baseline access.

### Team membership

Users join teams in two ways:

- Direct: an owner adds the user to the team.
- Organization membership: adding a user to a team through the organization-memberships relationship.

Removing a user from a team removes that team's grants immediately.

### SCIM-managed teams

Teams linked to SCIM groups are synchronized from the identity provider. SCIM-managed teams cannot be edited manually. See [Authentication](authentication).

## Team permissions

Each team carries organization-level permission flags:

- Manage workspaces.
- Manage variable sets.
- Manage VCS settings.
- Manage agent pools.
- Manage policies.
- Manage projects.
- Read projects.
- Manage memberships.
- Manage teams.
- Manage organization settings.
- Read state versions.
- Read variables.

The web interface renders these as checkboxes on the team page.

## Workspace access

Access to a workspace comes from:

- Team workspace access: a team with read, plan, or write access.
- Project access: the workspace's project.
- Organization role: owner and custom roles.

Workspace access levels are read, plan, and write. Write allows applies and variable changes.

## Project access

Team project permissions grant access to every workspace in the project. See [Projects](projects).

## API tokens for teams

Teams can mint team tokens. A team token acts with the team's permissions. See [Tokens](tokens).

## Audit

Team and membership changes appear in the audit trail. See [Audit trail](audit-trail).

## API surface

- `GET /api/v2/organizations/:org_name/teams`
- `POST /api/v2/organizations/:org_name/teams`
- `PATCH /api/v2/teams/:id`
- `DELETE /api/v2/teams/:id`
- `POST /api/v2/teams/:id/relationships/users`
- `GET /api/v2/organizations/:org_name/organization-memberships`
- `DELETE /api/v2/organization-memberships/:id`
