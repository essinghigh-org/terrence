---
title: API reference
category: Reference
order: 20
description: The JSON:API contract, authentication, errors, events, and the MCP server.
---

# API reference

The API implements the Terraform Cloud API contract. Tools written against that contract work unchanged.

## Base and format

- Base path: `/api/v2`.
- Format: JSON:API (`application/vnd.api+json`).
- Every response wraps resources in `data` with `id`, `type`, and `attributes`.
- Relationships appear under `relationships`.
- Collections paginate with `?page[number]=1&page[size]=20` and carry `meta.pagination`.

A few endpoints are exceptions to the JSON:API format:

- Upload and download endpoints use plain request and response bodies.
- The events stream is server-sent events (`text/event-stream`).
- The documentation endpoints return markdown.
- The metrics endpoint returns JSON or Prometheus text.

## Authentication

Send the token in the Authorization header:

```text
Authorization: Bearer <token>
```

Supported token types: user tokens, organization tokens, team tokens, run tokens, and browser session tokens. See [Tokens](tokens).

Unauthenticated requests receive a 401 JSON error.

## Errors

Errors follow the JSON:API error shape:

```json
{
  "errors": [
    { "status": "404", "title": "Not Found" }
  ]
}
```

Common status codes:

| Code | Meaning |
|---|---|
| 400 | Bad request |
| 401 | Missing or invalid token |
| 403 | Insufficient permission |
| 404 | Resource not found |
| 409 | Conflict (duplicate name, state lock) |
| 413 | Body too large |
| 422 | Validation failed, with detail pointers |
| 429 | Rate limit exceeded |
| 500 | Internal error |
| 503 | Maintenance or degraded storage |

Non-API paths return branded HTML 404 pages. Upload and download endpoints use plain bodies.

## Discovery

`GET /api/v2/meta` reports the API version and capabilities. `GET /api/v2/ping` is a lightweight liveness probe.

## Terraform protocol endpoints

The CLI uses these endpoints directly:

- `POST /api/v2/runs` with an uploaded configuration archive.
- `GET /api/v2/runs/:id` and the plan/apply log endpoints.
- `GET /api/v2/plans/:id/json-output` for the structured plan.
- `POST /api/v2/state-versions` and the upload endpoints.
- `GET /api/v2/state-versions/:id/download`.
- `POST /api/v2/workspaces/:id/actions/lock` and `unlock`.

The plan JSON output endpoint follows the availability contract: 204 while the plan is still planning, 404 when the artifact will never exist, 200 when planning is complete.

## Registry protocol endpoints

The registry serves the standard discovery paths:

- `/v1/modules/:namespace/:name/:provider/:version/...`
- `/v1/providers/:namespace/:name/:version/...`

Runs authenticate registry resolution with the run token.

## Events stream

`GET /api/v2/events` opens a server-sent events stream:

```text
event: connected
data: {"heartbeatMs":15000}
```

Topics:

| Topic | Payload | Purpose |
|---|---|---|
| `run.status` | run-id, workspace-id, org-id, status, at | Run transitions |
| `plan.output.ready` | run-id, workspace-id, org-id, plan-id | Plan JSON available |
| `comment.created` | run-id, workspace-id, org-id, comment-id | New run comment |

Heartbeats (`ping`) arrive every 15 seconds. Streams are capped at 50 connections and 5 per user. The stream ends after one hour; clients reconnect and re-resolve permissions.

Revocation closes streams immediately. See [Security](security).

## MCP server

Terrence exposes a Model Context Protocol server:

- `GET /mcp` opens an SSE transport session.
- `POST /mcp` sends JSON-RPC messages.

The MCP server exposes organization, workspace, and run tools. Clients authenticate with a user token. See the MCP tool list for the exact names.

## Rate limits

Login, registration, and password endpoints are rate limited per address. Exceeding the limit returns 429.

## Versioning

The API is additive. New endpoints and attributes are added without changing existing behavior. Attribute names use the contract's kebab-case convention.

## Documentation endpoints

The bundled documentation is served to authenticated users:

- `GET /api/v2/docs` lists the documentation index.
- `GET /api/v2/docs/:slug` returns one document in markdown.
