CREATE TABLE `control_plane_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`hostname` text NOT NULL,
	`address` text,
	`version` text,
	`status` text DEFAULT 'active' NOT NULL,
	`registered_at` integer NOT NULL,
	`last_heartbeat_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_nodes_hostname_idx` ON `control_plane_nodes` (`hostname`);--> statement-breakpoint
CREATE INDEX `control_plane_nodes_heartbeat_idx` ON `control_plane_nodes` (`status`,`last_heartbeat_at`);--> statement-breakpoint
CREATE TABLE `notification_configuration_workspace_exclusions` (
	`id` text PRIMARY KEY NOT NULL,
	`notification_configuration_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`notification_configuration_id`) REFERENCES `notification_configurations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_configuration_workspace_exclusions_idx` ON `notification_configuration_workspace_exclusions` (`notification_configuration_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `system_api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`description` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `system_api_tokens_token_hash_unique` ON `system_api_tokens` (`token_hash`);--> statement-breakpoint
ALTER TABLE `notification_configurations` ADD `email_all_members` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_configurations` ADD `email_user_ids` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `cost_estimation_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `session_timeout` integer;--> statement-breakpoint
ALTER TABLE `organizations` ADD `session_remember` integer;--> statement-breakpoint
ALTER TABLE `organizations` ADD `collaborator_auth_policy` text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `user_tokens_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `default_agent_pool_id` text;--> statement-breakpoint
ALTER TABLE `policies` ADD `kind` text DEFAULT 'sentinel' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `operation` text DEFAULT 'plan_and_apply' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `generated_configuration` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `execution_mode` text DEFAULT 'remote' NOT NULL;--> statement-breakpoint
ALTER TABLE `team_projects` ADD `organization_id` text REFERENCES organizations(id);--> statement-breakpoint
ALTER TABLE `variable_set_variables` ADD `hcl` integer DEFAULT false;