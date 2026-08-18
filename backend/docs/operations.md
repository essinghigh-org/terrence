---
title: Operations
category: Administration
order: 40
description: Maintenance mode, storage layout, backups, and the doctor script.
---

# Operations

This page covers the day-to-day operations of a Terrence instance: draining, storage, backups, and diagnostics.

## Maintenance mode

Maintenance mode stops run execution:

- The worker stops claiming pending runs.
- Auto-destroy and assessment discovery stop.
- Existing runs are not interrupted.

Enable maintenance mode in the operations settings or with the API. The instance keeps serving API and UI requests.

## Drain mode at shutdown

On SIGTERM, the instance:

1. Stops claiming new work.
2. Stops accepting HTTP connections.
3. Waits for in-flight executions, up to `TERRENCE_DRAIN_GRACE_MS` (default 6000 ms).
4. Checkpoints the database.
5. Exits.

A failed WAL checkpoint exits non-zero so supervisors can react. Set a container stop grace period longer than the drain grace, so SIGTERM has time to finish.

## Storage layout

The storage directory (`STORAGE_DIR`, default `./storage`) holds:

- The SQLite database (`terrence.db` with WAL files).
- Configuration version archives.
- State payloads.
- Downloaded binaries.
- Version cache.
- Run artifacts.

The directory must persist across container restarts. Mount it as a volume.

## Backups

A consistent backup contains:

1. The storage directory.
2. The SQLite database.

Take backups with the instance stopped or after a graceful shutdown. The WAL checkpoint at shutdown makes the main database file complete, so a backup taken right after stop never misses WAL tail pages.

For PostgreSQL, use the database's own backup tooling.

## Database export

The administration database section exports the database in a portable format:

- The export includes the schema and the data.
- Storage artifacts (archives and state payloads) are handled separately.

Restore an export into an empty instance, then restore the storage artifacts to the same paths.

## Diagnostics

The doctor script checks the instance health from the host:

```bash
bun backend/scripts/doctor.ts
```

Checks cover:

- Kernel and sandbox support.
- Storage writability.
- SQLite integrity.
- DNS resolution.
- VCS and certificate authority reachability.
- Configuration presence.

Use `--json` for machine output and `--fail` to exit 1 on any failed check.

## Health endpoints

- `GET /readyz` reports readiness. A degraded storage state returns 503.
- `GET /health` reports basic liveness.

The container health check uses these endpoints.

## Metrics

The `/metrics` endpoint exposes process, database, and worker gauges. See [Metrics](metrics).

## Single control plane

Terrence is a single-process application. Run exactly one control-plane instance. Remote agent pools can scale independently. Multiple control-plane replicas are not supported; PostgreSQL does not make replicas safe.
