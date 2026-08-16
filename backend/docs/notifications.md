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
| TLS mode | StartTLS or implicit TLS |
| Username and password | Authentication |
| From address | The sender shown to recipients |

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

## Delivery

Notifications are queued and delivered asynchronously. A failed delivery logs the error and increments the failure metric. The notification page shows recent deliveries.

## API surface

- `GET /api/v2/organizations/:org_name/notification-configurations`
- `POST /api/v2/organizations/:org_name/notification-configurations`
- `PATCH /api/v2/notification-configurations/:id`
- `DELETE /api/v2/notification-configurations/:id`
