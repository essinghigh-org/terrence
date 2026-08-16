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
- API tokens are stored as SHA-256 hashes, never plaintext.
- Browser access tokens live in memory. The refresh token lives in an HttpOnly cookie.
- Failed logins are rate limited.
- The first administrator is created only by the bootstrap flow, under an exclusive lock.
- Registered users never become site administrators.

## Run isolation

Runs execute inside a Landlock sandbox:

- The run process sees only its working directory and the binary directory.
- Provider plugins and local-exec provisioners inherit the restrictions.
- The database, encryption keys, and other workspaces are not visible.

The sandbox is required by default. See [Execution](execution).

## Credential isolation

Each run receives its own short-lived token:

- Delivered through a private CLI configuration file.
- Scoped to the run's workspace and organization.
- Revoked at run completion.
- Expires at most 24 hours after minting.

Runs never see user credentials.

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
- The release workflow runs only on `release:` commits.

## Event stream revocation

SSE connections resolve permissions at connect time. Revocations (membership removal, suspension, admin demotion, user deletion) close matching connections immediately. The browser reconnects and re-resolves.

## Multi-instance notes

Run exactly one control-plane instance. The event bus and the worker are in-process. Remote agents may scale independently.

See [Operations](operations).
