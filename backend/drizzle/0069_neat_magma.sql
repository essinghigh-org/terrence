CREATE TABLE `backup_rehearsal_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`result` text DEFAULT 'null',
	`error` text DEFAULT 'null',
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_rehearsal_jobs_one_running` ON `backup_rehearsal_jobs` (`status`) WHERE "backup_rehearsal_jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX `backup_rehearsal_jobs_started_idx` ON `backup_rehearsal_jobs` (`started_at`);