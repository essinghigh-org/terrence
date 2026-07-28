ALTER TABLE `runs` ADD `agent_pool_id` text REFERENCES agent_pools(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `runs` ADD `agent_id` text REFERENCES agents(id) ON DELETE set null;
--> statement-breakpoint
CREATE TABLE `agent_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`agent_pool_id` text NOT NULL,
	`agent_id` text,
	`phase` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`result` text,
	`error_message` text,
	`claimed_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_jobs_run_phase_idx` ON `agent_jobs` (`run_id`,`phase`);
--> statement-breakpoint
CREATE INDEX `agent_jobs_pool_status_created_idx` ON `agent_jobs` (`agent_pool_id`,`status`,`created_at`);
