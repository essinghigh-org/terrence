CREATE TABLE `state_output_index` (
	`output_id` text PRIMARY KEY NOT NULL,
	`state_version_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`state_version_id`) REFERENCES `state_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `state_output_index_workspace_idx` ON `state_output_index` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `state_output_index_state_idx` ON `state_output_index` (`state_version_id`);