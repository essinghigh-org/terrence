PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_state_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`serial` integer NOT NULL,
	`state_payload` text,
	`status` text DEFAULT 'finalized',
	`json_state` text,
	`json_state_outputs` text,
	`vcs_commit_sha` text,
	`vcs_commit_url` text,
	`run_id` text,
	`created_by` text,
	`terraform_version` text,
	`intermediate` integer DEFAULT false NOT NULL,
	`soft_deleted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_state_versions`("id", "workspace_id", "serial", "state_payload", "status", "json_state", "json_state_outputs", "vcs_commit_sha", "vcs_commit_url", "run_id", "created_by", "terraform_version", "intermediate", "soft_deleted_at", "created_at") SELECT "id", "workspace_id", "serial", "state_payload", "status", "json_state", "json_state_outputs", "vcs_commit_sha", "vcs_commit_url", "run_id", "created_by", "terraform_version", "intermediate", "soft_deleted_at", "created_at" FROM `state_versions`;--> statement-breakpoint
DROP TABLE `state_versions`;--> statement-breakpoint
ALTER TABLE `__new_state_versions` RENAME TO `state_versions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `state_versions_ws_serial_idx` ON `state_versions` (`workspace_id`,`serial`);--> statement-breakpoint
CREATE INDEX `state_versions_run_idx` ON `state_versions` (`run_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `login_failed_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `login_failure_window_started_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `login_locked_until` integer;