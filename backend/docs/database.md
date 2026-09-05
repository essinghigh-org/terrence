---
title: Database
category: Administration
order: 50
description: SQLite and PostgreSQL backends, migrations, and the migration wizard.
---

# Database

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

One-click migration (317) runs a post-copy checksum: row counts (318), aggregate hashes (319), FK verification (320), artifact references (321), and encrypted-blob decryptability (322). The checks fail closed if any aggregate or FK diverges.

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
