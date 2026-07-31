-- Persist the per-configuration-version auto-queue-runs flag instead of
-- discarding it after creation.
ALTER TABLE configuration_versions ADD COLUMN auto_queue_runs INTEGER NOT NULL DEFAULT 1;
