---
title: Audit trail tokens
category: Administration
order: 25
description: Stream audit entries to an external log collector.
---

# Audit trail tokens

An audit trail token lets an external system read the audit log. Log collectors use the token to ship audit entries to a central store.

## Create a token

Create an audit trail token in the organization settings, under the audit trail token section. The token is shown once at creation. Store it in the log collector's configuration.

## Scopes

A token can be scoped:

- Instance-wide (site administrators).
- One organization.

The token holder can query the audit endpoints and receive audit events.

## Rotation

Revoke a token to invalidate it immediately. Create a new token and update the collector.

## API surface

- `POST /api/v2/organizations/:org_name/audit-trail-tokens`
- `DELETE /api/v2/audit-trail-tokens/:id`
- `GET /api/v2/organizations/:org_name/audit-trail`
