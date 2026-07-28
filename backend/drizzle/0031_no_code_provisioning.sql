CREATE TABLE `no_code_variable_options` (
	`id` text PRIMARY KEY NOT NULL,
	`no_code_module_id` text NOT NULL,
	`variable_name` text NOT NULL,
	`variable_type` text NOT NULL,
	`options` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`no_code_module_id`) REFERENCES `no_code_modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `no_code_variable_options_module_name_idx` ON `no_code_variable_options` (`no_code_module_id`,`variable_name`);
--> statement-breakpoint
CREATE TABLE `no_code_workspace_configurations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`no_code_module_id` text,
	`module_id` text,
	`module_version_id` text,
	`configuration_version_id` text,
	`module_source` text NOT NULL,
	`module_version` text NOT NULL,
	`inputs` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`no_code_module_id`) REFERENCES `no_code_modules`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`module_id`) REFERENCES `registry_modules`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`module_version_id`) REFERENCES `registry_module_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`configuration_version_id`) REFERENCES `configuration_versions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `no_code_workspace_configurations_workspace_idx` ON `no_code_workspace_configurations` (`workspace_id`);
--> statement-breakpoint
CREATE INDEX `no_code_workspace_configurations_module_idx` ON `no_code_workspace_configurations` (`no_code_module_id`);
