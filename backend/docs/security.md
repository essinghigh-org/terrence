---
title: Security
category: Administration
order: 70
description: The security model: authentication, sandboxing, request limits, and network hardening.
---

# Security

This page describes the security model and the hardening applied across the instance.

## Authentication and sessions

- Passwords are hashed with bcrypt.
- API tokens are stored as installation-keyed HMAC-SHA-256 hashes, never plaintext. Existing SHA-256 rows are accepted once and upgraded on use.
- Browser access tokens live in memory. The refresh token lives in an HttpOnly cookie.
- Failed logins are rate limited.
- The first administrator is created only by the bootstrap flow, under an exclusive lock.
- Registered users never become site administrators.

## Run isolation

When `TERRENCE_RUN_SANDBOX` is enabled (the default), runs execute inside a Landlock sandbox:

- The run process sees only its working directory and the binary directory.
- Provider plugins and local-exec provisioners inherit the restrictions.
- The database, encryption keys, and other workspaces are not visible.

When `TERRENCE_RUN_SANDBOX=false`, those filesystem boundaries do not apply: the run executes as the service identity and may be able to read the storage and key files. Use that setting only for trusted development or on hosts with an equivalent isolation boundary. See [Execution](execution).

## Credential isolation

Each run receives its own short-lived token:

- Delivered through a private CLI configuration file.
- Scoped to the run's workspace and organization.
- Revoked at run completion.
- Expires at most 24 hours after minting.

Runs never see user credentials.

## Run log links

Plan/apply log URLs are bearer capabilities: an HMAC over run, phase, the
run's log token, and an expiry (default 48 hours, configurable up to 7 days
via `LOG_CAPABILITY_TTL_SECONDS`). They carry `no-store` / `no-referrer`
policies and never embed the log token itself.

- Links stop working at expiry, on explicit per-run revocation
  (`POST /api/v2/runs/:id/actions/revoke-log-links`), and when the run is
  soft-deleted (soft-deleted runs can neither issue nor honor links).
- Removing an organization membership (or demoting it from active)
  immediately rotates every live run-log token in the organization, so
  previously issued links stop working at once. Authorized clients fetch
  fresh links from the plan/apply responses to keep polling.
- Losing team-level access without losing the organization membership does
  not rotate links; those links stay valid until their short expiry.
- There is no short-window automatic renewal: a client holding only an
  expired link must re-authenticate through an authorized response.

## Webhook verification

Inbound webhooks verify signatures against the raw request body:

- GitHub: `x-hub-signature-256` (HMAC-SHA256).
- GitLab: token comparison.
- Bitbucket: `x-hub-signature` (HMAC-SHA1).

Verification happens before JSON parsing. Re-serialized bodies would break the signature, so every webhook path stays on the raw bytes.

## Request limits

- Upload endpoints accept up to 100 MiB.
- All other endpoints reject bodies over 4 MiB.
- Oversized requests return 413.
- The limits apply to chunked requests too.

## URL safety

Outbound requests (notifications, avatars, VCS fetches) follow safe URL rules:

- Private network addresses are refused by default.
- `TERRENCE_ALLOW_PRIVATE_URLS=true` opts out.
- Redirects are validated at every hop.

## Secret handling

- Sensitive variable values are masked in API responses.
- Environment secrets are never written to run logs.
- The secrets module centralizes encryption keys and access.
- Audit strict mode records sensitive reads. See [Audit trail](audit-trail).

Encryption is artifact-specific. State payloads, sensitive variable values, and
recovery captures use authenticated encryption; logs, plans, configuration
archives, generated configuration, and AI explanations remain plaintext private
artifacts. See the [operations storage table](operations#storage-layout) before
designing backup or access controls.

## IP allowlists

Organizations can restrict API access to CIDR ranges. Requests outside the allowed ranges are rejected. The allowlist applies per organization.

## Security headers

The web interface sends standard security headers:

- Content Security Policy.
- Frame protection.
- MIME sniffing protection.
- Referrer policy.

## Storage failure handling

A disk-full condition:

- Flips the storage-degraded flag.
- Stops the worker from claiming runs.
- Makes readiness return 503.
- Never corrupts state: failed writes are detected and reported.

## Supply chain

- The container image is built from pinned base images.
- Terraform, OpenTofu, and Infracost binaries are checksum-verified.
- Releases are published from Git tags (`v*.*.*`). The image bakes immutable `BUILD_VERSION`/`BUILD_SHA` from the tag and commit.

## Event stream revocation

SSE connections resolve permissions at connect time. Revocations (membership removal, suspension, admin demotion, user deletion) close matching connections immediately. The browser reconnects and re-resolves.

## Multi-instance notes

Run exactly one control-plane instance. The event bus and the worker are in-process. Remote agents may scale independently.

See [Operations](operations).
