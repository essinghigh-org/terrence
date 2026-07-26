CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`user_id` text,
	`org_id` text,
	`description` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_unique` ON `api_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `configuration_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`archive_path` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `logs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`phase` text NOT NULL,
	`output_text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `logs_run_phase_idx` ON `logs` (`run_id`,`phase`);--> statement-breakpoint
CREATE TABLE `organization_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `variable_set_variables` (
	`id` text PRIMARY KEY NOT NULL,
	`variable_set_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`sensitive` integer DEFAULT false,
	`category` text DEFAULT 'terraform' NOT NULL,
	`description` text,
	FOREIGN KEY (`variable_set_id`) REFERENCES `variable_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variable_set_variables_idx` ON `variable_set_variables` (`variable_set_id`,`key`);--> statement-breakpoint
CREATE TABLE `variable_set_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`variable_set_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`variable_set_id`) REFERENCES `variable_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variable_set_workspaces_idx` ON `variable_set_workspaces` (`variable_set_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `variable_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`global` integer DEFAULT false,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspace_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_tags_workspace_key_idx` ON `workspace_tags` (`workspace_id`,`key`);--> statement-breakpoint
CREATE TABLE `workspace_variables` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`sensitive` integer DEFAULT false,
	`category` text DEFAULT 'terraform' NOT NULL,
	`description` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`configuration_version_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`message` text,
	`is_destroy` integer DEFAULT false,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`configuration_version_id`) REFERENCES `configuration_versions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_runs`("id", "workspace_id", "configuration_version_id", "status", "message", "is_destroy", "created_at") SELECT "id", "workspace_id", NULL, "status", "message", false, unixepoch() * 1000 FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_state_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`serial` integer NOT NULL,
	`state_payload` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_state_versions`("id", "workspace_id", "serial", "state_payload") SELECT "id", "workspace_id", "serial", "state_payload" FROM `state_versions`;--> statement-breakpoint
DROP TABLE `state_versions`;--> statement-breakpoint
ALTER TABLE `__new_state_versions` RENAME TO `state_versions`;--> statement-breakpoint
CREATE UNIQUE INDEX `state_versions_ws_serial_idx` ON `state_versions` (`workspace_id`,`serial`);--> statement-breakpoint
CREATE TABLE `__new_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`org_id` text NOT NULL,
	`iac_binary` text,
	`terraform_version` text DEFAULT 'latest',
	`auto_apply` integer DEFAULT false,
	`locked` integer DEFAULT false,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_workspaces`("id", "name", "org_id", "iac_binary", "terraform_version", "auto_apply", "locked") SELECT "id", "name", "org_id", NULL, "terraform_version", "auto_apply", "locked" FROM `workspaces`;--> statement-breakpoint
DROP TABLE `workspaces`;--> statement-breakpoint
ALTER TABLE `__new_workspaces` RENAME TO `workspaces`;--> statement-breakpoint
ALTER TABLE `organizations` ADD `default_iac_binary` text DEFAULT 'tofu';--> statement-breakpoint
ALTER TABLE `organizations` ADD `default_terraform_version` text DEFAULT 'latest';
