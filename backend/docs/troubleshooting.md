---
title: Troubleshooting
category: Reference
order: 30
description: Common problems and their resolutions.
---

# Troubleshooting

This page collects common problems and their fixes.

## A run stays pending forever

Check in order:

1. Is the worker running? `TERRENCE_DISABLE_WORKER` must not be `1`.
2. Is maintenance mode active? The operations settings show it.
3. Is storage degraded? `GET /metrics` shows `terrence_storage_degraded`. A full disk stops claims.
4. Is the workspace locked? Locked workspaces refuse new claims.
5. Is an older run stuck in a non-terminal state? A stuck run blocks its workspace. See the run status.
6. Is the workspace in agent mode without a reachable pool? The run moves to `unreachable`.

The worker poller metrics show whether the queue scan runs. See [Metrics](metrics).

## A run is stuck in an active state

A process restart during execution leaves a run in a transient state. Terrence reconciles these at startup:

- Pre-execution states return to `pending`.
- Execution states move to `errored`.
- Interrupted applies are never replayed.

If the run is still stuck, restart the container. The startup reconciliation runs again.

## The plan JSON endpoint returns 204

204 means the plan is still running. Poll later, or subscribe to `plan.output.ready` on the events stream. 404 means the artifact will never exist (plan-only or failed run).

## A VCS push does not create a run

Check:

1. The webhook secret matches the provider configuration.
2. The webhook endpoint is reachable: `PUBLIC_URL/api/webhooks/<provider>`.
3. The workspace is connected to the repository.
4. The changed files match the trigger prefixes or patterns.
5. The branch matches the workspace branch.

Webhook deliveries with wrong signatures are rejected silently. Check the instance logs.

## Terraform refuses to apply from the CLI

A VCS-connected workspace refuses CLI applies. The server executes the repository checkout. Use the API to confirm the run, or connect the workspace to an uploaded configuration instead.

## `terraform login` fails

- The instance must be reachable over HTTPS from your machine.
- The login flow requires the browser. Use a token from the account page if the browser flow fails.
- Check `PUBLIC_URL`. Callbacks use it.

## Runs fail with a sandbox error

The sandbox is required by default. The error explains the kernel requirement:

- Linux 5.13 or newer.
- `CONFIG_SECURITY_LANDLOCK` enabled.
- The `landlock` LSM active.

Set `TERRENCE_RUN_SANDBOX=false` only if you accept unsandboxed runs.

## Cost estimates are missing

- `INFRACOST_ENABLED` must be `true`.
- The binary must be reachable. Terrence manages the pinned version on demand.
- `INFRACOST_API_KEY` is needed for price lookups.
- Cost estimation never blocks the apply. A missing estimate is not an error.

## Health assessments do not run

- Enable assessments on the workspace, or enforce them at the organization level.
- Check `HEALTH_ASSESSMENT_CONCURRENCY`. Running assessments count against it.
- Check the assessment discovery cadence (`TERRENCE_ASSESSMENT_POLL_MS`).
- A workspace with an active run skips assessment discovery.

## Memory grows after restarts

Use `GET /metrics` and the process history:

- A sawtooth RSS pattern with a flat heap is normal garbage collection.
- Monotonic growth with rising heap is a leak. Report it.

See [Metrics](metrics).

## The container does not stop cleanly

The shutdown sequence drains the worker, stops HTTP, and checkpoints the database. `TERRENCE_DRAIN_GRACE_MS` is a millisecond value (default 6000). The container's `stop_grace_period` is a seconds value. Set `stop_grace_period` above the grace in seconds, for example `30s`, so SIGTERM has time to finish before SIGKILL.

## The database migration fails

- Migrations are generated with Drizzle tooling. Do not hand-write them.
- Check `MIGRATION_CHECKPOINT_RETRIES` and `MIGRATION_DRAIN_TIMEOUT_MS`.
- The doctor script checks database integrity. See [Operations](operations).

## Where to look next

- The instance logs: run, worker, and poller messages with structured metadata.
- `GET /metrics`: worker health, failures, storage state.
- The [Operations](operations) page: doctor script, health endpoints, backup procedure.
