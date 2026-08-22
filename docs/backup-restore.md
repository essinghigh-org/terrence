# Backup / restore (30)

Contract: a Terrence backup is a `pg_dump` (or SQLite copy) plus a
manifest (`manifest.json`) listing the backup kind, timestamp and SHA.
Restore replays the dump against a fresh instance and verifies row counts.

Executable harness: `backend/tests/api/backup-restore.test.ts` exercises
manifest hash verification and the fail-closed restore path.
