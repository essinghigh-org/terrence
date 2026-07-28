CREATE TABLE `notification_configurations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`team_id` text,
	`project_id` text,
	`name` text NOT NULL,
	`destination_type` text NOT NULL,
	`url` text NOT NULL,
	`triggers` text NOT NULL,
	`enabled` integer DEFAULT true,
	`token` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`default_execution_mode` text DEFAULT 'remote',
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_org_name_idx` ON `projects` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `ssh_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ssh_keys_org_name_idx` ON `ssh_keys` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `team_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_memberships_team_user_idx` ON `team_memberships` (`team_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `team_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`access` text DEFAULT 'write' NOT NULL,
	`permissions` text,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_workspaces_team_workspace_idx` ON `team_workspaces` (`team_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`visibility` text DEFAULT 'organization' NOT NULL,
	`sso_team_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_org_name_idx` ON `teams` (`org_id`,`name`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`configuration_version_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`message` text,
	`is_destroy` integer DEFAULT false,
	`auto_apply` integer DEFAULT false NOT NULL,
	`plan_only` integer DEFAULT false NOT NULL,
	`refresh` integer DEFAULT true NOT NULL,
	`refresh_only` integer DEFAULT false NOT NULL,
	`target_addrs` text,
	`replace_addrs` text,
	`variables` text,
	`log_token` text,
	`terraform_version` text,
	`debugging_mode` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`configuration_version_id`) REFERENCES `configuration_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_runs`("id", "workspace_id", "configuration_version_id", "status", "message", "is_destroy", "auto_apply", "plan_only", "refresh", "refresh_only", "target_addrs", "replace_addrs", "variables", "log_token", "terraform_version", "debugging_mode", "created_by", "created_at") SELECT "id", "workspace_id", "configuration_version_id", "status", "message", "is_destroy", "auto_apply", "plan_only", "refresh", "refresh_only", "target_addrs", "replace_addrs", "variables", "log_token", "terraform_version", "debugging_mode", "created_by", "created_at" FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `team_id` text REFERENCES teams(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `project_id` text REFERENCES projects(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `ssh_key_id` text REFERENCES ssh_keys(id) ON DELETE SET NULL;
