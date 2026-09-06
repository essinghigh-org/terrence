---
title: Remote client retry contract
category: Compatibility
order: 6
description: Idempotency, retry headers, and status-code semantics for remote clients.
---

# Remote client retry contract

Remote clients may lose a response after Terrence commits a write. A retry is
safe when the original request carried an `Idempotency-Key` and the retry uses
the same key, caller, endpoint scope, and request body.

## Idempotent creates

The following resource-creating requests accept `Idempotency-Key`:

- `POST /api/v2/workspaces/:workspace_id/configuration-versions`
- `POST /api/v2/workspaces/:workspace_id/runs` and `POST /api/v2/runs`
- `POST /api/v2/workspaces/:workspace_id/state-versions`
- `POST /api/v2/workspaces/:workspace_id/state-versions/upload`
- `PATCH /api/v2/workspaces/:workspace_id/state-versions` (rollback)
- `POST /api/v2/state-versions/:state_version_id/actions/rollback`

Keys are scoped to the endpoint and workspace (or source state version),
bound to the authenticated user, team, or organization principal, and bound to
the canonical JSON request body. A key can be at most 255 characters. Completed
results are retained for 24 hours. The server returns the original resource
identity on replay and adds `Idempotency-Replayed: true`; signed links in a
stored response should be refreshed through the resource read endpoint when
they expire.

Reusing a key with a different body, principal, or resource type returns
`409 Conflict`. A matching request that is still running also returns `409`
with `Retry-After: 1`. A validation or authorization failure happens before a
key is reserved, so the caller can correct the request and retry it.

## Status and retry behavior

Clients should preserve the JSON:API error document and branch on the HTTP
status:

- `401` means authentication is missing or expired; refresh or authenticate.
- `403` means the authenticated principal lacks the required capability.
- `404` means the object is missing or intentionally hidden from that principal.
- `400` and `422` are request-shape or validation failures.
- `409` is a state, lock, already-applied, or idempotency conflict; refresh the
  resource before deciding whether a new operation is needed.
- `429` is rate limiting; honor `Retry-After`.
- `503` is temporary unavailability; honor `Retry-After` and retry only a safe
  read or a write carrying an idempotency key.

The frontend's explicit pagination helper retries only its `GET` requests for
`429` and `503`, at most three times, and stops when `Retry-After` asks it to
wait more than 30 seconds. Ordinary API calls do not retry transport or
server failures, and mutating requests are never retried generically.

Signed upload URLs are separate capabilities from API authentication. An
expired or invalid signed URL must be replaced by fetching the parent resource
again; retrying the same URL cannot renew it. A completed state upload with
the same bytes is convergent, while different bytes or a stale reservation
remain a `409 Conflict`.
