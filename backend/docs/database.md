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

## Export format

The export is a JSON document with:

- The schema version.
- Tables and rows.
- Foreign key references.

Imports are idempotent. A re-import after a failure does not duplicate rows.

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

One-click migration (317) runs a post-copy checksum: row counts (318), aggregate hashes (319), FK verification (320), artifact references (321), and encrypted-blob decryptability (322).

## Performance

Hot paths are indexed:

- Run queue scans by status and creation time.
- Workspace run lists.
- Scheduled applies.
- Workspace listings per organization.

Adding an index to a hot path is a schema change and goes through the migration tooling.

## API surface

- `POST /api/v2/admin/database/export`
- `POST /api/v2/admin/database/import`
- `GET /api/v2/admin/database/status`
