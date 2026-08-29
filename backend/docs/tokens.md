---
title: Tokens
category: Organizations and access
order: 50
description: API tokens, fine-grained scopes, and run tokens.
---

# Tokens

Tokens authenticate every API request. The token is sent as `Authorization: Bearer <token>`.

## Token types

| Type | Scope | Uses |
|---|---|---|
| User token | The user's access | CLI, API, automation |
| Organization token | One organization | Team automation |
| Team token | One team | Team automation |
| Run token | One run | Terraform CLI inside a run |
| Session token | One browser session | Web interface |

## User tokens

A user creates tokens in the account page or through the API. Each token has a description and an expiry. Installation-keyed token hashes are stored, never the plaintext. Set `TERRENCE_TOKEN_HASH_SECRET` consistently across replicas; single-node installs persist a generated secret in `STORAGE_DIR/.token-hash-secret`.

Revoking a token invalidates it immediately.

## Organization and team tokens

Organization owners create organization tokens. Team owners create team tokens. A team token acts with the team's permissions. These tokens are full-permission tokens for their scope.

## Fine-grained tokens

A user token can carry scopes. Scopes restrict the token to:

- Specific organizations.
- Specific projects.
- Specific workspaces.
- Specific tags.
- A set of permission grants.

A scoped token cannot mint new tokens. Requests outside the scope are rejected.

## Run tokens

Every executed run receives a short-lived credential:

1. The worker mints a token before execution.
2. The token is written into a private CLI configuration file in the run directory.
3. Terraform uses it for state and registry access during the run.
4. The token is revoked when the run reaches a terminal state.

Run tokens expire at most 24 hours after minting. A run that dies with the process has its token revoked at startup reconciliation.

## Session tokens

Browser sessions use a refreshable session token. The access token lives in memory. The refresh token lives in an HttpOnly cookie. Sessions refresh transparently.

## Revocation and events

Token revocation is immediate. User suspension, user deletion, and admin demotion close live event streams at once. The web interface reconnects and re-resolves permissions.

## API surface

- `POST /api/v2/users/:id/authentication-tokens`
- `DELETE /api/v2/authentication-tokens/:id`
- `POST /api/v2/organizations/:org_name/authentication-token`
- `DELETE /api/v2/organizations/:org_name/authentication-token`
- `POST /api/v2/teams/:id/authentication-token`
- `DELETE /api/v2/teams/:id/authentication-token`
