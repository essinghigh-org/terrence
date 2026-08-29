---
title: Site administration
category: Administration
order: 10
description: The admin dashboard: users, organizations, workspaces, runs, and versions.
---

# Site administration

Site administration is the instance-wide management surface. Only site administrators can open it.

## Access

Site administrators are created by the bootstrap flow or by an existing administrator. The admin section appears in the sidebar for administrators.

## Sections

| Section | Manages |
|---|---|
| Security | Authentication providers, session policy, signup |
| Users | User accounts, suspension, roles |
| Organizations | All organizations and their settings |
| Workspaces | All workspaces, execution modes, locks |
| Runs | All runs, queue state, run controls |
| Versions | Installed binaries and versions |
| Compatibility | Provider compatibility surface |
| Audit | Audit log entries |
| Auth | OIDC, SAML, LDAP configuration |
| SMTP | Outbound email |
| SCIM | Identity provisioning |
| Operations | Maintenance mode, apply gates |
| Database | Export, migration, maintenance |

## Users

The users table lists every account. Administrators can:

- Create users.
- Grant or revoke site admin.
- Grant or revoke site auditor.
- Suspend and unsuspend.
- Impersonate for diagnostics.
- Delete accounts.

Suspension takes effect immediately, including live event streams.

## Organizations and workspaces

Administrators see every organization and workspace. The tables filter by name and status. Workspace rows expose the execution mode and lock state.

## Runs

The runs table lists every run on the instance. Administrators can cancel or force-cancel runs from any organization.

## Versions and compatibility

The versions section shows the installed Terraform and OpenTofu binaries. The provider compatibility dashboard compares the tracked `hashicorp/tfe` provider release recorded in `backend/src/data/provider_surface.json` and reports whether a newer release is available. It shows which resources and data sources are covered, planned, or missing.

## Audit

The audit section queries the audit log. See [Audit trail](audit-trail).

## API surface

- `GET /api/v2/admin/users`
- `PATCH /api/v2/admin/users/:id`
- `POST /api/v2/admin/users/:id/actions/suspend`
- `POST /api/v2/admin/users/:id/actions/grant_admin`
- `POST /api/v2/admin/users/:id/actions/revoke_admin`
- `GET /api/v2/admin/organizations`
- `GET /api/v2/admin/workspaces`
- `GET /api/v2/admin/runs`
- `GET /api/v2/admin/provider-surface`
