DROP INDEX `durable_jobs_kind_dedupe_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `durable_jobs_kind_dedupe_idx` ON `durable_jobs` (`kind`,`dedupe_key`);