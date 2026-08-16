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

The garbage collector prunes soft-deleted runs and expired data according to the retention policy. `GC_GRACE_PERIOD_DAYS` controls the grace period for deleted runs.

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
