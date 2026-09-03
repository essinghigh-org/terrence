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
| Operations | Maintenance mode, apply gates, runtime log levels and remote syslog destinations |
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

## Settings updates

Site-admin settings are stored as one JSON object per settings group. Every
read-modify-write update is serialized by group: SQLite uses an in-process
queue, and PostgreSQL also uses the shared lease-backed `locks` table so the
same guarantee holds across backend replicas. Different keys in concurrent
PATCH requests are merged from the latest committed group state. If concurrent
requests change the same key, the last request to acquire the group lock wins.
Cache invalidation occurs after the group write commits.

## Logging and remote syslog

The Operations page and `GET/PATCH /api/v2/admin/logging-settings` configure
runtime logging without a restart. The settings are stored in the `logging`
group. Local and remote levels accept `error`, `warn`, `info`, or `debug`.
Set `enabled` to false to disable remote delivery even when environment
variables specify a destination.
Remote destinations are one `udp://host:port` or `tcp://host:port` value per
entry, with up to 16 entries. Syslog delivery is best effort and fans out to
every configured destination; a failed collector does not block other
collectors or the application logger.

Environment variables remain the bootstrap fallback when the corresponding
Site Admin value is unset:

- `LOG_LEVEL` controls local logging.
- `TERRENCE_SYSLOG_TARGET` controls one remote destination.
- `TERRENCE_SYSLOG_TARGETS` controls comma/newline-separated destinations and
  takes precedence over the singular variable when non-empty.
- `TERRENCE_SYSLOG_LEVEL`, `TERRENCE_SYSLOG_HOSTNAME`, and
  `TERRENCE_SYSLOG_APP` control remote level and identity.
- `TERRENCE_SYSLOG_FORMAT` selects the message shape: `rfc5424` (default,
  meta as dotted structured-data params) or `json` (one bare JSON object
  per datagram with no syslog envelope, auto-extracted by json
  sourcetypes such as Splunk).

A persisted non-null Site Admin value overrides its environment fallback. An
explicit empty `syslog-targets` array disables environment-configured remote
sinks. Existing environment-only deployments continue to work. Running
replicas re-read the persisted logging group periodically, so a PATCH reaches
each replica without a restart (the PATCH-serving replica applies it
immediately).

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
- `GET/PATCH /api/v2/admin/logging-settings`
