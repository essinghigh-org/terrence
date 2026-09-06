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

Application encryption varies by artifact; filesystem permissions and gzip compression are not encryption. A full backup includes every row and file below, including plaintext artifacts. Protect backups with storage encryption and restrict access to the service account.

| Artifact | Location and contents | Application encryption | Retention and deletion |
| --- | --- | --- | --- |
| State versions and outputs | Database; resource state and output values | Encrypted payload columns | State retention and explicit backing-data deletion |
| Workspace and variable-set secrets | Database variable rows | Sensitive values encrypted; non-sensitive values plaintext | Variable deletion and database backup retention |
| Run-specific variables | Run row JSON; may contain credentials | New sensitive inputs use authenticated encryption in the JSON record; older records require the backfill below. Non-sensitive inputs remain plaintext | Run deletion and database backup retention |
| Live run logs | Database log rows; CLI and provider output | Plaintext | Run retention archives logs before deleting live rows |
| Archived logs | `run-logs/*.json.gz` | Plaintext indexed gzip chunks (legacy gzip JSON also readable), mode `0600` | Run retention/deletion |
| Raw and agent plan JSON | `plan-json/`; input, resource and output values | Plaintext, files created with mode `0600` | Run retention/deletion; public responses are projected separately |
| Saved binary plans | `saved-plans/`; may embed input values and prior state | Plaintext private files | Saved-plan cleanup; include retained plans in backups |
| Configuration archives | `cv/`, `configuration_versions/`; uploaded or fetched source | Plaintext archives; source may contain secrets | Configuration-version retention/deletion |
| Recovery state | `recovery/`; interrupted-apply snapshot | Encrypted captured state; temporary execution files can be plaintext | Successful recovery removes its capture directory |
| Generated configuration | Execution work directories; generated HCL and private variable files | Plaintext private files | Execution-directory cleanup |
| AI explanations | Database `run_explanations`; generated text | Plaintext; prompts carry the SEC-01 plan projection (or the apply tail) scrubbed by value against sensitive variables/outputs, responses are scrubbed the same way, and each generation writes an audit row with endpoint host plus redaction counts (never secrets). Cache entries generated before this minimization may contain previously disclosed values | Regeneration/run deletion; assess old backups separately |

The directory must persist across container restarts. Mount it as a volume. At boot Terrence fails fast when the directory is not writable and logs the exact `chown` fix with path and UID.

## Backups

Terrence does not automatically encrypt or retain operator backups, and it does not provide an RPO alarm. The release build manifest is provenance for the software image and migration set; it is not a backup manifest. Create a small checksum manifest beside each operator backup. A consistent backup captures the database and the storage directory at one logical point:

1. Stop the instance (or quiesce writes). The WAL checkpoint at shutdown makes the main database file complete.
2. Copy the database file and the whole storage directory together. A database-only copy is not restorable: state payloads, outputs, SSH keys, OAuth tokens, and sensitive variables decrypt only with `.encryption-key` (or the stable `ENCRYPTION_PASSWORD`) plus `.encryption-salt` from the same storage directory (SSH keys and tokens are encrypted database columns; the wizard's URL secret is a file under `secrets/`). The salt has no env override, so restoring the database on a new host with the same password but a fresh salt still fails to decrypt.
3. Write and verify a checksum manifest. For a stopped SQLite instance, the following is a complete, reproducible example (the directory contains the database and all key material):

   ```sh
   backup=/var/backups/terrence/$(date -u +%Y%m%dT%H%M%SZ)
   mkdir -p "$backup"
   tar --create --file "$backup/storage.tar" --directory "$STORAGE_DIR" .
   sha256sum "$backup/storage.tar" > "$backup/SHA256SUMS"
   sha256sum --check "$backup/SHA256SUMS"
   ```

   PostgreSQL backups use `pg_dump` (or `pg_basebackup`) and the same storage archive. Keep the database dump and storage archive from the same quiesced window.
4. Restore into an empty disposable directory, verify the checksum, and run the documented diagnostics before replacing the live volume:

   ```sh
   sha256sum --check "$backup/SHA256SUMS"
   mkdir -p /tmp/terrence-restore
   tar --extract --file "$backup/storage.tar" --directory /tmp/terrence-restore
   STORAGE_DIR=/tmp/terrence-restore DATABASE_URL=file:/tmp/terrence-restore/terrence.db \
     bun backend/scripts/doctor.ts --json
   ```

5. Verify by starting a scratch instance against the copy and logging in. The repository check `bun backend/scripts/verify-operations-docs.ts` performs this disposable copy/restore and diagnostics pass; CI also runs the database upgrade fixture.

For PostgreSQL, use the database's own backup tooling; combine a `pg_dump`/`pg_basebackup` window with a storage snapshot taken at the same logical point. Downgrades are not supported: migrations are forward-only, so a backup taken before an upgrade is the only way back.

### Backup verification and restore rehearsal

Site administrators can create and verify backup evidence from the administrative API. These operations never replace the active database or storage volume:

- `POST /api/v2/admin/backups/manifests` creates `terrence-backup-manifest.json`. With no path it describes the active database read snapshot and storage files. Pass `backup-path` (and, when needed, `database-path` and `storage-path`) to describe a stopped SQLite copy or archive instead.
- `POST /api/v2/admin/backups/integrity-checks` (also `/backups/verify`) is read-only. It checks the manifest checksum, SQLite `quick_check`, schema digest, every recorded table count, storage-file SHA-256 values, referenced archives, key fingerprints, and selected decryptable records. It reports failures for missing files, changed artifacts, wrong keys, and incompatible schema before any restore decision.
- `POST /api/v2/admin/backups/restore-rehearsals` extracts or copies the backup into a private temporary directory, repeats the checks, applies the bundled SQLite migrations to a disposable database copy, and runs a harmless `tofu version` or `terraform version` workflow when a CLI is available. Poll `GET /api/v2/admin/backups/restore-rehearsals/:rehearsal_id` for the result.
- `GET /api/v2/admin/backups/status` reports `last-verified-restore-at`. This is the last successful rehearsal time; it is deliberately separate from a backup's creation timestamp.

The manifest records only key presence and SHA-256 fingerprints. It never contains key values, and key export remains an explicit operator decision. Do not place `.encryption-key`, `.encryption-salt`, or password material in support bundles. For SQLite, stop the instance or enter a write-quiesced window before copying the database and storage directory; the API does not claim that a live copy is restorable merely because a manifest was generated. For PostgreSQL, provision an isolated database from `pg_dump`/`pg_basebackup` and run the database-specific restore checks before cutover.

The rehearsal endpoint has no corresponding restore endpoint. Replacing a live volume requires a separately reviewed shutdown, fencing/reconciliation, key-retention, and confirmation plan after the rehearsal passes.

## Interrupted-apply recovery

When an apply is canceled or the process dies mid-apply, the worker captures the local `terraform.tfstate` (if present) encrypted into `recovery/<run-id>/`. Fetch it before it expires:

- `GET /api/v2/runs/:run_id/recovery-state`

Unrecovered copies are kept until recovery consumes them; they are never time-pruned because they may be the only record of changed infrastructure. `TERRENCE_RECOVERY_RETENTION_MS` (default 7 days) controls saved-plan expiry only. Markerless client-encrypted copies are also retained for manual investigation; see [state encryption and recovery](state#client-encrypted-opentofu-state).

## Cancellation and deadlines

Request cancellation is carried through plan explanations, Stack source downloads, archive validation and Stack Terraform subprocesses. A canceled or lease-lost durable job aborts its transport, stops its child process, and releases its spooled output; the durable lease remains the authority for finalization. Each operation keeps its own deadline, so a metadata request, archive inspection, plan, and apply do not share one generic timeout. Apply cancellation remains cooperative first so the worker can capture recovery state, then escalates to a forced process-group/cgroup stop when the grace period expires. A run is not reported complete until the process and ownership checks have settled.

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

## Help a user regain access

In **Site administration → Users**, find the user and choose **Reset password**. Enter and confirm a temporary password that satisfies the instance policy, then share it through a secure channel. The user must choose a new password at their next login. Resetting a password revokes existing API tokens and refresh sessions, and invalidates outstanding MFA login challenges. MFA remains enabled.

This action is for other users with local passwords. Use Account settings for your own password, or the identity provider for an SSO-only account. Recovery of the only administrator is described in [Configuration](configuration).


### Backfill historical sensitive run inputs

With the same database, storage and encryption settings as the server, run `bun run scripts/encrypt-run-variables.ts` from `backend`. The command processes 100 run records at a time, encrypts only legacy sensitive entries, and can be rerun after interruption. It does not print variable values. Preserve the encryption key with backups; existing backups may still contain plaintext and need their normal secure retention/deletion policy. New run creation encrypts sensitive inputs before queuing execution. Both local workers and agent payloads decrypt only for execution.

## Run-log download capabilities

Plan/apply resource reads return fresh, signed log URLs. Each signature binds the run, phase, expiry and current run token version. The installation signing secret authenticates the URL; the previously exposed run token is not a signing key. Signatures are in the path because go-tfe replaces the query string with byte offsets. Responses prohibit caching and referrer forwarding.

`LOG_CAPABILITY_TTL_SECONDS` defaults to 172800 (48 hours), allowing the default 24-hour apply timeout plus polling headroom. Values must be positive integer seconds, at most 604800 (7 days); invalid values use the default. Choose a lifetime longer than expected queueing plus execution if clients acquire links before a phase starts. Shorter lifetimes limit disclosure but can interrupt older CLI log readers, which retain a single URL. An authorized client can resume by reading the plan/apply resource and opening its fresh `log-read-url`; older clients may need the command restarted.

Removing a user's/team's access prevents new links immediately. Existing bearer links remain usable until their stated expiry (up to 48 hours by default), unless explicitly revoked. For immediate revocation, a workspace administrator sends `POST /api/v2/runs/:run_id/actions/revoke-log-links`. This invalidates both phases' existing links, records an audit event, and allows authorized readers to obtain replacements. It also interrupts existing CLI readers. Run retention disables capabilities when soft-deleting the run; authorized archive reads continue through the authenticated log endpoint.

Previously issued unsigned log URLs stop working after this upgrade. Fetch a fresh plan/apply resource to obtain the new format. No short-lived automatic renewal is claimed for legacy CLI streams.


### Archived log bounds

New run-log archives use independently compressed JSON chunks, followed by a bounded JSON index and an eight-byte footer (little-endian index length plus `TRL2`). The existing `.json.gz` filename remains unchanged; the complete file is an indexed container, not a single gzip document. Use the authenticated log APIs to read it. Earlier gzip JSON envelopes and bare arrays remain readable, with a 64 MiB decompression limit; their older format still requires full-document parsing.

Retention preserves the most recent 10,000 rows, with the original row count and truncation marker. New archives permit at most 64 MiB of output text, 1 MiB per row, and a 4 MiB index. A chunk contains at most 32 rows and normally at most 256 KiB of output text (a larger single row forms its own chunk). Writes compress asynchronously; page and byte-range reads only decompress intersecting chunks. Metadata and decoded logs are not cached indefinitely. There is one active archive operation and room for 31 waiting operations per process. An overflowing queue fails explicitly; retention processes runs sequentially rather than filling it.

Temporary files are published with one atomic rename after all chunks and the index are written. A size-limit or I/O failure leaves live logs available. Disk-full failures also latch storage degradation. Failed replacement writes leave the prior archive intact and remove their temporary file.

The opt-in load check creates two runs with 2,000 rows and approximately 16 MiB of output each. It prepares one archive, then concurrently queues four writes for the live run, eight reads from the archived run, and 40 authenticated run-status requests. Run it from `backend` with an empty binary cache so startup integrity verification does not distort the archive measurement:

```sh
TERRENCE_BINARY_CACHE_DIR=/tmp/empty-archive-benchmark-cache LOG_ARCHIVE_LOAD=1 bun test tests/api/run_log_archive_load.test.ts
```

A local SQLite comparison against `ad656f99` measured:

| Metric | Previous whole-document archive | Indexed chunks |
| --- | ---: | ---: |
| Kernel peak RSS, including fixture and application startup | 842 MB | 293 MB |
| Run-status p95, 40 requests | 355 ms | 52 ms |
| Maximum event-loop delay | 358 ms | 50 ms |

These are workload observations, not latency guarantees. Peak RSS comes from the operating system rather than an event-loop timer, which misses allocations while synchronous work blocks it. The functional archive check additionally verifies UTF-8 byte windows, legacy formats, bounded admission, selective chunk reads, and a disk-full failure after the first temporary chunk has been written.

### Optional icon discovery

Provider metadata lookups and avatar refreshes share a process-local admission budget: 64 operations total, eight active, no more than 32 admitted or two active per hostname. Every operation has a four-second deadline including queue time. Expired queued work never starts; a caller can cancel queued work, and a canceled active request retains its slot until it stops. A slow host therefore cannot fill the entire admission budget. Existing DNS validation, pinned connections, origin-bound private-network exceptions, response-type checks, and the 2 MiB avatar limit still apply.

Provider metadata responses return a stable same-origin provider path immediately; its image route serves a deterministic SVG fallback while the registry lookup refreshes metadata in the background. Rejected lookups retain the fallback result; avatar requests can serve an existing cached image or report a temporary failure. Provider lookup failures are cached for 30 seconds (admission rejections for five seconds), separately from the 512-entry positive cache so invalid-source floods cannot evict known icons. The negative cache also holds at most 512 entries. Registry JSON responses are limited to 1 MiB. Avatar refresh failures have a five-second, 512-entry negative cache, avatar metadata writes are capped at 128 pending records, and the organization-name cache holds at most 1,024 entries.

Instance process metrics expose `process.snapshot.discovery`: `active`, `queued`, `rejected`, `canceled`, `timedOut`, and `limit`. These are aggregate counters and contain no hostnames or credentials. The discovery checks cover per-host fairness, caller cancellation, canonical-source deduplication, cache preservation, oversized metadata, and pending-record limits. Reproduce the flood check from `backend`:

```sh
TERRENCE_BINARY_CACHE_DIR=/tmp/empty-discovery-benchmark-cache DISCOVERY_LOAD=1 bun test tests/unit/provider-icons.test.ts --test-name-pattern 'distinct-source flood'
```

In the local 5,000-source workload, two lookups were active, 30 were queued, and 4,968 returned a fallback without entering the queue. Kernel peak RSS for the complete test process was 142 MB, including application startup; this is an observation rather than a production memory guarantee.
