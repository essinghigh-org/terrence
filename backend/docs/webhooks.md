---
title: Webhooks
category: Registry and VCS
order: 40
description: Inbound and outbound webhooks for VCS, registry, and notifications.
---

# Webhooks

Webhooks move events in both directions: providers notify Terrence, and Terrence notifies external services.

## Inbound webhooks

| Endpoint | Purpose | Signature |
|---|---|---|
| `/api/webhooks/github` | GitHub App events: pushes, pull requests, registry tags | `x-hub-signature-256` |
| `/api/webhooks/gitlab` | GitLab push and merge request events | `x-gitlab-token` |
| `/api/webhooks/bitbucket` | Bitbucket push and pull request events | `x-hub-signature` |
| `/api/v2/webhooks/run-approval` | External approval of pending applies | HMAC signature |

Every signature is verified against the raw request body, before any JSON parsing. A delivery with a wrong signature is rejected.

## Registry tag webhooks

A repository that publishes modules or providers sends a tag event. Terrence fetches the tagged version and publishes it to the registry. The module page shows the sync status.

## Outbound notifications

Terrence sends event notifications through configurable adapters:

- Email over SMTP.
- Apprise channels.

Notification configurations attach to organizations or workspaces. Each configuration selects the events it reports and the destination.

See [Notifications](notifications).

## Run approval webhooks

Pending applies can be approved through an external service. The service calls the approval endpoint with a valid signature. The apply then proceeds through the normal lifecycle.

## Security

Webhook endpoints follow the same hardening as the rest of the API:

- Signature verification against raw bytes.
- Per-endpoint secret configuration.
- Replay-safe processing where the provider includes event IDs.

See [Security](security).
