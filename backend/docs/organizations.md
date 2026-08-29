---
title: Organizations
category: Organizations and access
order: 10
description: Tenants, organization settings, and lifecycle.
---

# Organizations

An organization is the top-level tenant in Terrence. It owns workspaces, projects, variable sets, teams, registry entries, and its own settings.

## Create an organization

Create an organization from the dashboard or the API. The required attributes are a name and an email. Names are unique across the instance.

The creator becomes the organization owner.

## Organization settings

The organization settings page controls:

- General settings: name, email, and display options.
- Teams and roles.
- Users and memberships.
- IP allowlists.
- Tags.
- SSH keys.
- Service provider configuration (OIDC, SAML).

## Memberships

Users join an organization through an organization membership. Each membership carries a role:

| Role | Scope |
|---|---|
| Owner | Full control, including deletion. |
| Member | Standard access. |
| Custom | A subset of permissions defined by the owner. |

Memberships are managed from the users tab in the settings page, or through the teams page.

See [Teams](teams) for the permission model.

## Session controls

Organizations can set session requirements:

- Minimum session length.
- Maximum session length.
- Session refresh behavior.

These settings apply to user sessions inside the organization.

## IP allowlists

An organization can restrict API access to CIDR ranges. Requests from other addresses are rejected. See the IP allowlists tab in the settings page.

## Tags

Organization-level tags attach to workspaces. Tags filter listings and can scope fine-grained token rules.

## Deleting an organization

Deleting an organization removes:

- All workspaces and their data.
- Runs, state versions, and configuration versions.
- Variable sets and variables.
- Teams and memberships.
- Registry entries.
- API tokens.

The operation requires the owner role. It is irreversible.

## API surface

- `GET /api/v2/organizations`
- `POST /api/v2/organizations`
- `GET /api/v2/organizations/:org_name`
- `PATCH /api/v2/organizations/:org_name`
- `DELETE /api/v2/organizations/:org_name`
- `GET /api/v2/organizations/:org_name/entitlement-set`
