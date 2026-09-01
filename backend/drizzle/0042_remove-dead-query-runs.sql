DROP TABLE `query_runs`;--> statement-breakpoint
ALTER TABLE `agent_jobs` ADD `fencing_token` integer DEFAULT 0 NOT NULL;