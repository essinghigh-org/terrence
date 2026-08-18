---
title: Metrics
category: Administration
order: 60
description: The metrics endpoint, its formats, and what the gauges mean.
---

# Metrics

The metrics endpoint exposes operational telemetry. It answers the common questions: is the worker healthy, is the database growing, is the process leaking memory.

## Endpoint

```text
GET /metrics
```

The endpoint requires a valid token. Site administrators see instance-wide metrics. Fine-grained tokens see only their scoped resources.

Format:

- Default: JSON.
- `?format=prometheus`: Prometheus text format, ready for a scraper.

## Metrics groups

| Group | Contents |
|---|---|
| `terrence_users_total` | User count |
| `terrence_organizations_total` | Organization count |
| `terrence_workspaces_total` | Workspace count |
| `terrence_runs_total` | Run count |
| `tfe_run_current_count` | Runs grouped by current status |
| `terrence_database_*` | Database size, WAL size, page counts |
| `terrence_process_*` | RSS, heap, CPU, uptime |
| `terrence_requests` | Request totals, in-flight, 5xx count |
| `terrence_failures` | Failure counters per subsystem |
| `terrence_storage_degraded` | Storage degradation flag |
| `terrence_worker` | Poll counts, per-poller stats |
| `terrence_process_history` | Ring buffer of samples |

## Worker metrics

The `terrence_worker` object reports:

- `polls`: fast poll cycle count.
- `last_poll_at` and `last_poll_duration_ms`.
- `last_poll_ok`.
- `pollers`: per-poller runs, errors, last duration, last ok.

The pollers are:

| Poller | Cadence | Purpose |
|---|---|---|
| `pollWorkerQueue` | 1.5 s | Claim pending runs |
| `applyDueScheduledRuns` | 1.5 s | Claim due scheduled applies |
| `enqueueDueAutoDestroyRuns` | 30 s | Discover auto-destroy targets |
| `enqueueDueAssessments` | 60 s | Discover and claim assessments |

Zero errors and `last_ok: true` across all pollers means a healthy worker.

## Process history

The history ring samples every 10 seconds, up to 720 samples (2 hours). Each sample records RSS, heap used, in-flight requests, and worker poll count.

Use the history to judge memory behavior:

- A sawtooth pattern with a flat heap is garbage collector churn, not a leak.
- Monotonic RSS growth with rising heap is a leak.

The history is in memory. A restart clears it.

## Storage degradation

`terrence_storage_degraded` flips to 1 when writes fail with disk-full errors. While degraded, the worker stops claiming runs and readiness returns 503. The flag clears when writes succeed again.

## Failures

`terrence_failures` counts per-subsystem failures: audit writes, run log writes, and others. The counters help correlate symptoms with causes.
