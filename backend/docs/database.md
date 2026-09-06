---
title: Database
category: Administration
order: 50
description: SQLite and PostgreSQL backends, migrations, and the migration wizard.
---

# Database

## Supported deployment topology

Run exactly **one active Terrence control-plane process**, with either SQLite or PostgreSQL. The process owns the scheduler, local workers, cancellation state and in-memory event delivery. PostgreSQL does not supply leader election or make multiple control-plane replicas safe. Remote agents add execution capacity; they do not replace this ownership model.

Keep the database, artifact storage and encryption/token secrets together in the backup and restore procedure. For failover, stop or fence the old control plane before starting its replacement with the restored database, storage and secrets. Do not use a rolling deployment with overlapping instances, including during database migration. Follow the [upgrade and rollback procedure](upgrading.md) and [operations guide](operations.md).

Terrence supports two database backends. The backend is selected by `DATABASE_URL`.

## SQLite

The default backend. The database is a file:

```text
DATABASE_URL=file:./storage/terrence.db
```

SQLite runs in WAL mode with foreign keys enforced. The single process shares one connection, which serializes writes.

## PostgreSQL

Set `DATABASE_URL` to a PostgreSQL connection string. Terrence applies its schema migrations at startup.

PostgreSQL is recommended when the dataset outgrows SQLite or when you need the database tooling ecosystem.

## Migrations

Schema migrations are generated with Drizzle tooling. Migrations apply:

- At module load for SQLite.
- Explicitly at startup for PostgreSQL.

Do not write migrations by hand. Generate them with the project tooling.

## Migration wizard

The administration database section includes a migration wizard. The wizard moves data between instances or database backends:

1. Export the source database.
2. Restore into the target.
3. Verify the migration.

The wizard handles the schema and the data. Storage artifacts must move separately.

## Boot configuration file

The wizard switches the database backend from inside the UI, but a container cannot permanently change an environment variable. The wizard therefore writes `storage/terrence.json`:

```json
{
  "database": {
    "driver": "postgres",
    "urlSecret": "database-url"
  }
}
```

Precedence (highest wins):

1. `DATABASE_URL` environment variable (never written back to the file). Setting it silently overrides the wizard: after migrating via the wizard, exporting `DATABASE_URL` for SQLite reverts the instance to SQLite on next boot.
2. The boot configuration file.
3. Default: SQLite at `<storage>/terrence.db`.

`urlSecret` names an encrypted blob under `storage/secrets/`; the file never carries the URL in plaintext. A plaintext `url` key is also accepted for deployments that manage the URL out of band. Back up `terrence.json` with the storage directory, and restore it alongside the encryption key and salt: without the matching key, the secret cannot be decrypted.

## Export format

The Postgres-to-SQLite export is a background job (see [Operations](operations) for the endpoint list). The export artifact is a SQLite database file built with the source schema and copied rows, verified against the source snapshot (row counts, invariants, content hashes) before the job completes. Content hashing is full-table up to the full-digest limit (5000 rows by default, raisable per export via the 'full-digest-limit' attribute) for tables with a primary key; tables without one always use sampled coverage. Beyond the limit (or without a key) a first-rows sample is hashed (size via 'sample-limit', 1000 by default); the verification report states per-table coverage 'full' or 'sample' with the rows hashed, so a pass on a sampled table is never mistaken for full coverage. There is no import endpoint: feed the file to the migration wizard, which restores from it. The export does not include storage artifacts; move those separately.

## Integrity

The doctor script checks SQLite integrity with the built-in integrity check. See [Operations](operations).

## GC and retention

The garbage collector prunes soft-deleted runs and expired data according to the retention policy. `GC_GRACE_PERIOD_DAYS` controls the grace period for deleted runs. Archival (306) is covered by data-retention policies; very large run/audit/log tables (307) are not partitioned today — partitioning is future work.

## Maintenance

Scheduled `ANALYZE` (308) runs via the database's own autovacuum/autovacuum-analyze; no in-app periodic `ANALYZE` is scheduled. `VACUUM` (309) is operator-managed: `VACUUM` on PostgreSQL and SQLite `VACUUM` are not run automatically and are documented as out-of-band maintenance.

## WAL

SQLite WAL growth (310) is bounded by periodic checkpointing (311): `PRAGMA wal_checkpoint(TRUNCATE)` runs at GC intervals. Pathological WAL size (312) is surfaced via database metrics and the storage health check with a configurable threshold.

## Observability

DB write latency (313) is tracked via the pool metrics window. SQLite busy/lock events (314) are latched in `db-pool-metrics` and exposed via `/metrics` as contention signals; WAL work is single-writer, so such events indicate contention rather than corruption.

## Scale limits

SQLite scale limit (315): single-writer, WAL, no replication; recommended for small teams and dev installs. Migrate to PostgreSQL when concurrent write contention or dataset size grows. The migration wizard handles the move.

Migration point (316): consider PostgreSQL when busy/lock events climb, WAL checkpoint pressure rises, or backup/restore windows lengthen. The wizard is one-click.

## Post-copy verification (317-322)

The SQLite-to-PostgreSQL wizard verifies row counts, full ordered content digests for tables with primary keys, foreign keys and the target migration journal. Tables without primary keys report count/FK coverage explicitly. It also checks that non-null archive references in configuration versions, policy-set versions, registry-module versions and module-test configuration versions resolve to regular files. Missing files prevent switching; the report and manifest include per-table checked/unavailable counts without paths or content.

Encrypted database values are copied and included in content digests. This verifies preservation of the stored envelope, not decryptability of every secret. Keep the matching encryption secrets and artifact storage with the database. The round-trip test verifies decryptability of a representative encrypted value using those retained secrets.

After an interruption, the next status read reports `interrupted`. Restore missing artifacts if reported, then resume with the same target connection URL. The wizard replays its idempotent schema/copy steps and repeats verification before allowing a switch. The source remains the active database until the switch. Do not start a second control plane on the target during recovery.

## Portable invariant inventory

CI runs the same domain and upgrade fixtures on both database backends. Test names identify the backend actually used. A separate cross-database step starts the application on SQLite with `PG_TEST_ADMIN_URL` pointing to a disposable PostgreSQL service; explicit PostgreSQL setup failures fail that step.

| Invariant | Executable evidence |
| --- | --- |
| Tables, column defaults, uniqueness, indexes and foreign-key endpoints/actions agree | `tests/db/schema-parity.test.ts` |
| Unique and missing-relationship constraints return redacted conflicts; asynchronous transactions roll back | `tests/db/domain-invariants.test.ts` |
| Baseline and previous bundled migration upgrades preserve identities and constraints; replay is idempotent | `tests/db/upgrade-invariants.test.ts` |
| JSON order, booleans, nulls, millisecond timestamps, membership roles, token hashes and sensitive envelopes survive SQLite → PostgreSQL → SQLite export | `tests/api/db-migration.test.ts` |
| Missing archive references prevent switching; repair and interrupted-state resume repeat verification | `tests/api/db-migration.test.ts`, `tests/unit/migration-artifacts.test.ts` |
| Export snapshot counts, relationships and declared hash coverage match | `tests/api/db-export.test.ts`, `tests/unit/db-transfer-verify.test.ts` |

Run the cross-database fixture from `backend/` with `PG_TEST_ADMIN_URL` set and `DATABASE_URL` absent:

```sh
bun test tests/api/db-migration.test.ts tests/api/db-export.test.ts --max-concurrency=1 --no-orphans
```

The fixture creates and drops disposable target databases. Run `tests/db/domain-invariants.test.ts` and `tests/db/upgrade-invariants.test.ts` once with SQLite defaults and once with a PostgreSQL `DATABASE_URL` to exercise both implementations.

## Performance

Hot paths are indexed:

- Run queue scans by status and creation time.
- Workspace run lists.
- Scheduled applies.
- Workspace listings per organization.

Adding an index to a hot path is a schema change and goes through the migration tooling.

## API surface

- `POST /api/v2/admin/db-export/test-connection`
- `POST /api/v2/admin/db-export`
- `GET /api/v2/admin/db-export/jobs/:job_id`
- `GET /api/v2/admin/db-export`
- `GET /api/v2/admin/db-export/files/:file_name`
- `DELETE /api/v2/admin/db-export/files/:file_name`

## Provider compatibility database checks

`bun test tests/e2e/provider_e2e.test.ts` from `backend` uses isolated SQLite databases by default. With a PostgreSQL `DATABASE_URL`, each provider workflow creates a fresh PostgreSQL database, starts the real server against it, verifies the server's database mode, and drops it after stopping the server. The PostgreSQL account needs permission to create and drop these test databases. An unavailable target fails; the harness does not fall back to SQLite. The regular PostgreSQL CI job includes this workflow for both Terraform and OpenTofu.

The test prints its engine, database kind and sandbox profile, and writes `profile.json` beside its server log. `TERRENCE_E2E_KEEP_WORKDIR=1` retains these artifacts. Database credentials are excluded from the profile. Temporary PostgreSQL databases are always dropped, including when storage is retained for debugging. Fresh-server boot migrates the schema before admin bootstrap and route/background-worker initialization.

The default test security profile is `disabled`. To verify production sandboxing, build `backend/bin/build-landlock-runner.sh` from the repository root, then run the provider test with `TERRENCE_E2E_SECURITY_PROFILE=required`. The Linux host must support Landlock. This profile sandboxes both server-side runs and the actual provider CLI/child processes, using the production helper and filesystem policy. Provider installs stay inside the test workdir. A missing helper or unavailable sandbox fails the test instead of disabling protection. The provider compatibility CI job runs this profile with Terraform.
