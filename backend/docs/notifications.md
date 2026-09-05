---
title: Notifications
category: Administration
order: 30
description: Event notifications through SMTP email and Apprise channels.
---

# Notifications

Terrence sends event notifications through adapters. Notifications cover run lifecycle events and assessment outcomes.

## Adapters

| Adapter | Channel |
|---|---|
| SMTP | Email through an SMTP server |
| Apprise | Webhooks, Slack, Telegram, and other channels supported by Apprise |

## SMTP setup

Configure SMTP in the administration settings:

| Setting | Purpose |
|---|---|
| Host and port | The SMTP server |
| Encryption | `starttls`, implicit `tls`, or explicitly insecure `plain` |
| Username and password | Authentication |
| From address | The sender shown to recipients |

`starttls` is the default for non-465 ports. Terrence sends `STARTTLS` after
the initial `EHLO` and fails delivery if the server does not accept the
upgrade; it never sends `AUTH` after a rejected or unsupported STARTTLS
response. `tls` starts an encrypted connection before the SMTP greeting and is
the normal choice for port 465.

`plain` disables STARTTLS and sends the SMTP session without transport
encryption. It is an explicit insecure opt-in for trusted local relays only;
credentials are not protected in transit. Existing settings without an
encryption value retain implicit TLS on port 465 and use required STARTTLS on
other ports.

For anonymous relays, select `None` as the authentication type. Terrence then
sends no `AUTH` command, while the transport still requires STARTTLS unless
`plain` is explicitly selected.

A test message confirms the configuration.

## Notification configurations

A notification configuration attaches to an organization or a workspace. Each configuration:

- Picks a destination (email address or Apprise channel).
- Selects the event types to report.
- Enables or disables the configuration.

The organization settings page manages configurations.

## Events

Run events include:

- Run planning started.
- Run completed (applied).
- Run errored.
- Run needs attention (planned, awaiting confirmation).
- Policy soft failure.

Assessment events report completed and errored assessments.

## Workspace webhook destinations

Workspace, project, and team webhook notification configurations post destination-native payloads: generic raw event JSON, Slack blocks, Discord embeds, or Microsoft Teams MessageCards. Email notification configurations deliver to configured recipient addresses through SMTP. A failing destination trips a per-configuration circuit breaker after three consecutive failures (one-minute cooldown); deliveries retry twice on timeouts and 5xx.

Post a fixture event without enabling anything with the verify action (`POST /api/v2/notification-configurations/:id/actions/verify`); `?preview=true` returns the exact body that would be sent. Every send records a last-delivery outcome (`last-delivery` on the configuration resource, null until the first send) so failures surface on the notifications tab instead of living only in server logs.

## Delivery

Notifications are queued and delivered asynchronously. A failed delivery logs the error and increments the failure metric. The notification page shows recent deliveries.

## API surface

- `GET /api/v2/admin/smtp-settings`
- `PATCH /api/v2/admin/smtp-settings`
- `POST /api/v2/admin/smtp-settings/test`
- `GET /api/v2/organizations/:org_name/notification-configurations`
- `POST /api/v2/organizations/:org_name/notification-configurations`
- `PATCH /api/v2/notification-configurations/:id`
- `DELETE /api/v2/notification-configurations/:id`
