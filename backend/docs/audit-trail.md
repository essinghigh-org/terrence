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

The stored `details` object has a versioned envelope. Its stable fields are
`schemaVersion`, `action`, `result` (`success`, `denied`, or `failure`),
`requestId`/`correlationId`, `credentialClass`, `credentialId`,
`effectiveScope`, `actor`, and `target`. State and run transitions also carry
bounded `before` and `after` metadata. The envelope distinguishes the
authenticated principal from the effective user during impersonation, and
records the scope used for the authorization decision (legacy, fine-grained,
organization, team, run, or system).

## Consequential-action inventory

The following actions are required to leave an event before their result is
exposed to a caller or worker:

| Action | Target and evidence |
| --- | --- |
| Run apply, cancel, discard, force-cancel, force-execute | Run ID, workspace, status transition, request and actor scope |
| Policy override and external approval | Run ID, justification length/content after redaction, status transition |
| State create, promote, recovery | Workspace and state-version ID, serial, representation and transition; payload bytes are never stored |
| Comment create and delete | Comment ID, run/workspace, author or administrator decision, body length; comment text is excluded from deletion events |
| Capability/token issuance and revocation | Credential class, target identity and safe token identifier; bearer material is excluded |
| Administrator impersonation start/end | Impersonator, effective user and linking impersonation token ID |

Denied impersonation and comment-deletion attempts are recorded with
`result: "denied"`. Destructive, approval, recovery, promotion and
impersonation events are marked `immutable: true`; there is no update API for
audit rows, and the domain transaction writes the required event together
with the state change where atomicity is required.

Comment deletion is one explicit invariant: the comment row and its immutable
delete event commit in the same transaction, so a successful deletion cannot
return without an audit record. Denied deletion attempts record one bounded
reason and never include the comment body.

Secrets are removed while the event is constructed. Recursive values are
bounded, credential-like keys are replaced with `[REDACTED]`, and signed or
bearer URLs have their query/path credential removed before insertion. Audit
exports contain event metadata and scope only; raw plan, state, comment-body,
private-key and bearer-token content is not an audit field.

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

Audit writes use the same database transaction as the state change for
approval overrides, state promotion/recovery, and other domain operations
that must not become visible without their event. Best-effort background
events still increment the `auditWrites` failure metric and emit a structured
error when storage is unavailable; callers never receive raw audit-write
errors or secret-bearing diagnostics.

## API surface

- `GET /api/v2/admin/audit-trail`
- `GET /api/v2/organizations/:org_name/audit-trail`
