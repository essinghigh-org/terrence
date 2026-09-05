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

A failed WAL checkpoint exits non-zero so supervisors can react. Budget the full shutdown: about 2s for the draining write, up to 5s stopping HTTP, up to `TERRENCE_DRAIN_GRACE_MS` (default 6s, max 25s) draining workers, then the WAL checkpoint. Require an explicit 30s stop timeout so the checkpoint always fits: the shipped `docker-compose.yml` sets `stop_grace_period: 30s`; bare `docker run` needs `--stop-timeout 30`.

## Storage layout

The storage directory (`STORAGE_DIR`, default `<repo>/backend/storage`, `/app/backend/storage` in the container) holds:

- The SQLite database (`terrence.db` with WAL files) unless `DATABASE_URL` selects PostgreSQL.
- `storage/terrence.json`: boot configuration written by the migration wizard (see [Database](database)).
- Encryption material: `.encryption-key` (auto-generated when `ENCRYPTION_PASSWORD` is unset), `.encryption-salt` (KDF salt, no env override), `.token-hash-secret`.
- `secrets/`: encrypted blobs referenced by name (for example the migration wizard's database-URL secret). SSH keys, OAuth tokens, and variable values are encrypted columns in the database.
- `cv/`: configuration-version archives. `state-uploads/`: pending state-upload temp files.
- `saved-plans/`: saved plan files. `recovery/`: interrupted-apply recovery copies (see below).
- `exports/`: Postgres-to-SQLite export job files. `binaries/`: downloaded Terraform/OpenTofu/Infracost binaries.
- Version cache file.

State payloads, run logs, and variable values live as encrypted blobs in the database, not as files. The directory must persist across container restarts. Mount it as a volume. At boot Terrence fails fast when the directory is not writable and logs the exact `chown` fix with path and UID.

## Backups

There is no backup manifest, hashing, encryption, restore test, or RPO alarm feature: anything promising those describes roadmap, not the product. A consistent backup captures the database and the storage directory at one logical point:

1. Stop the instance (or quiesce writes). The WAL checkpoint at shutdown makes the main database file complete.
2. Copy the database file and the whole storage directory together. A database-only copy is not restorable: state payloads, outputs, SSH keys, OAuth tokens, and sensitive variables decrypt only with `.encryption-key` (or the stable `ENCRYPTION_PASSWORD`) plus `.encryption-salt` from the same storage directory (SSH keys and tokens are encrypted database columns; the wizard's URL secret is a file under `secrets/`). The salt has no env override, so restoring the database on a new host with the same password but a fresh salt still fails to decrypt.
3. Verify by starting a scratch instance against the copy and logging in.

For PostgreSQL, use the database's own backup tooling; combine a `pg_dump`/`pg_basebackup` window with a storage snapshot taken at the same logical point. Downgrades are not supported: migrations are forward-only, so a backup taken before an upgrade is the only way back.

## Interrupted-apply recovery

When an apply is canceled or the process dies mid-apply, the worker captures the local `terraform.tfstate` (if present) encrypted into `recovery/<run-id>/`. Fetch it before it expires:

- `GET /api/v2/runs/:run_id/recovery-state`

Unrecovered copies are pruned after `TERRENCE_RECOVERY_RETENTION_MS` (default 7 days). The run log names the endpoint and the expiry when a copy is captured.

## Database export

The Postgres-to-SQLite export runs as a background job for the migration wizard:

- `POST /api/v2/admin/db-export/test-connection`
- `POST /api/v2/admin/db-export`
- `GET /api/v2/admin/db-export/jobs/:job_id`
- `GET /api/v2/admin/db-export`
- `GET /api/v2/admin/db-export/files/:file_name`
- `DELETE /api/v2/admin/db-export/files/:file_name`

There is no generic export endpoint and no import endpoint. Default SQLite installs back up with the stop-and-copy procedure above. See [Database](database) for the wizard flow and the boot-config interaction.

## Diagnostics

The doctor script checks the instance health from the host:

```bash
bun backend/scripts/doctor.ts
```

Inside the container image (`backend/scripts` ships in the runtime image),
run it with `docker exec`:

```bash
docker exec <container> bun /app/backend/scripts/doctor.ts --fail
```

`--fail` exits non-zero when any check fails, for monitoring wrappers;
without it doctor only reports and always exits 0.

Checks cover:

- Kernel and sandbox support.
- Storage writability.
- Database reachability (SQLite integrity via `quick_check`; PostgreSQL via TCP handshake) plus whether the admin bootstrap completed (ADMIN_PASSWORD is consumed at first boot, so its absence after boot is normal).
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
