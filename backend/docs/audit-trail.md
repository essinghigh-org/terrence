---
title: Audit trail
category: Administration
order: 20
description: The audit log, strict mode, and retention.
---

# Audit trail

The audit trail records administrative and sensitive operations. It answers who did what, when, and with which actor.

## What is recorded

The audit log covers:

- User and membership changes.
- Team changes.
- Token creation and revocation.
- Organization and workspace deletion.
- Sensitive variable reads.
- SSH key access.
- State version downloads.
- Administrative actions.

Every entry carries:

- The actor (user, token, or system).
- The action.
- The target resource.
- The timestamp.
- The request metadata when available.

## Strict mode

Strict mode adds the especially sensitive operations to the log:

- Token minting.
- SSH key access.
- Sensitive variable reads.

Enable it with `AUDIT_STRICT=1`. Raw state downloads are always audited, with or without strict mode.

## Viewing the audit log

Site administrators query the audit log in the administration section. The query filters by actor, action, target, and time range.

## Retention

Audit entries are subject to the instance retention policy. Configure retention in the site settings. Entries older than the retention window are removed by the garbage collector.

The garbage collector also removes soft-deleted runs and stale data according to the retention configuration.

## Reliability

Audit writes are durable. A failure to record an audit entry increments the failure metric and logs a structured error. The audit log is never silently dropped.

## API surface

- `GET /api/v2/admin/audit-trail`
- `GET /api/v2/organizations/:org_name/audit-trail`
