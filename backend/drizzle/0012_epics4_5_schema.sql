CREATE TABLE `project_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_tags_project_key_idx` ON `project_tags` (`project_id`,`key`);
--> statement-breakpoint
CREATE TABLE `remote_state_consumers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`consumer_workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`consumer_workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_state_consumers_ws_consumer_idx` ON `remote_state_consumers` (`workspace_id`,`consumer_workspace_id`);
--> statement-breakpoint
CREATE TABLE `data_retention_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL UNIQUE,
	`state_versions_count` integer,
	`auto_destroy_at` text,
	`auto_destroy_activity_duration` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `auto_destroy_activity_duration` text;
--> statement-breakpoint
ALTER TABLE `projects` ADD `setting_overwrites` text;
--> statement-breakpoint
ALTER TABLE `projects` ADD `default_agent_pool_id` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `auto_apply_run_trigger` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `file_triggers_enabled` integer DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `trigger_prefixes` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `trigger_patterns` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `vcs_repo` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `queue_all_runs` integer DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `speculative_enabled` integer DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `allow_destroy_plan` integer DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `global_remote_state` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `project_remote_state` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `agent_pool_id` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `assessments_enabled` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `auto_destroy_at` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `auto_destroy_activity_duration` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `setting_overwrites` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `locked_reason` text;
--> statement-breakpoint
ALTER TABLE `configuration_versions` ADD `source` text DEFAULT 'tfe-api';
--> statement-breakpoint
ALTER TABLE `configuration_versions` ADD `ingress_attributes` text;
