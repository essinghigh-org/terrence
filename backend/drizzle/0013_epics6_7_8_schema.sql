CREATE TABLE `variable_set_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`variable_set_id` text NOT NULL,
	`project_id` text NOT NULL,
	FOREIGN KEY (`variable_set_id`) REFERENCES `variable_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variable_set_projects_idx` ON `variable_set_projects` (`variable_set_id`,`project_id`);
--> statement-breakpoint
ALTER TABLE `variable_sets` ADD `priority` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `configuration_versions` ADD `status_timestamps` text;
--> statement-breakpoint
ALTER TABLE `configuration_versions` ADD `error` text;
--> statement-breakpoint
ALTER TABLE `configuration_versions` ADD `error_message` text;
--> statement-breakpoint
ALTER TABLE `state_versions` ADD `status` text DEFAULT 'finalized';
--> statement-breakpoint
ALTER TABLE `state_versions` ADD `json_state` text;
--> statement-breakpoint
ALTER TABLE `state_versions` ADD `json_state_outputs` text;
--> statement-breakpoint
ALTER TABLE `state_versions` ADD `vcs_commit_sha` text;
--> statement-breakpoint
ALTER TABLE `state_versions` ADD `vcs_commit_url` text;
--> statement-breakpoint
ALTER TABLE `state_versions` ADD `run_id` text REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null;
