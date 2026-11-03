CREATE TABLE `admin_tfpolicy_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`official` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`beta` integer DEFAULT false NOT NULL,
	`deprecated` integer DEFAULT false NOT NULL,
	`deprecated_reason` text,
	`archs` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_tfpolicy_versions_version_unique` ON `admin_tfpolicy_versions` (`version`);--> statement-breakpoint
CREATE TABLE `policy_set_stacks` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_set_id` text NOT NULL,
	`stack_id` text NOT NULL,
	`is_exclude` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`policy_set_id`) REFERENCES `policy_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_set_stacks_idx` ON `policy_set_stacks` (`policy_set_id`,`stack_id`);--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `ado_org_name` text;--> statement-breakpoint
ALTER TABLE `policy_sets` ADD `tag_match_logic` text DEFAULT 'any';--> statement-breakpoint
ALTER TABLE `registry_components` ADD `tag_bindings` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `registry_modules` ADD `tag_bindings` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `registry_providers` ADD `tag_bindings` text DEFAULT '[]' NOT NULL;