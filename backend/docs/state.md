---
title: State
category: Workspaces and runs
order: 130
description: State versions, downloads, locks, and the state explorer.
---

# State

Terrence stores one state per workspace. State is versioned, locked, and downloadable.

## State versions

Every successful apply produces a state version. Each version records:

- The workspace.
- The serial number.
- The run that produced it.
- The payload.

State versions are immutable. The current version is the one Terraform uses for the next run.

## State downloads

Download the current state or any historical version. The download endpoint issues a signed URL with a limited lifetime (`SIGNED_URL_TTL_SECONDS`).

State downloads are always recorded in the audit trail.

## State locking

Terraform locks the state during plans and applies. The lock prevents two runs from writing the same workspace. A run that cannot acquire the lock waits.

Workspace locks are separate. A manually locked workspace refuses new runs entirely. See [Workspaces](workspaces).

## State uploads

The CLI uploads state through the standard endpoints. Direct API uploads are also supported with a configuration version reference.

The worker downloads the latest finalized state before each plan so the run sees the current infrastructure.

## The state explorer

The explorer view shows a read-only summary of the current state:

- Workspaces and their latest state.
- Projects and tags.
- Latest runs.
- Resource counts.

Use the explorer for a fast inventory without querying every workspace.

## State history

The workspace page shows the state version history with serials and dates. Select a version to download or inspect it.

## Interrupted-apply recovery

Power loss mid-apply is the standard homelab failure mode. When the process restarts with a run stuck in `applying`, boot reconciliation copies the run's `terraform.tfstate` into `<storage>/recovery/<run-id>/` (atomically written, read-back verified, marked complete) and the run log tells you a copy was captured.

- `GET /api/v2/runs/:run_id/recovery-state` downloads the captured state (requires workspace admin). Returns 404 when no verified copy exists.
- `POST /api/v2/runs/:run_id/actions/recover-state` promotes the captured state into a new finalized state version (requires state-write permission plus holding the workspace lock). A successful recovery consumes the copy: it is deleted afterwards.
- The run page shows a Recover action whenever a verified copy exists.

Unrecovered copies are kept until they are recovered: they may be the only record of the infrastructure state, so they are never time-pruned. `TERRENCE_RECOVERY_RETENTION_MS` (default 7 days) now governs saved-plan expiry only.

## API surface

- `GET /api/v2/workspaces/:id/current-state-version`
- `GET /api/v2/workspaces/:id/state-versions`
- `GET /api/v2/state-versions/:id`
- `GET /api/v2/state-versions/:id/download`
- `POST /api/v2/workspaces/:id/state-versions`
- `POST /api/v2/state-versions/:id/upload`
- `POST /api/v2/workspaces/:id/actions/lock`
- `POST /api/v2/workspaces/:id/actions/unlock`
