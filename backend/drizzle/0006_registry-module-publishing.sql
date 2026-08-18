ALTER TABLE `registry_module_versions` ADD `commit_sha` text;--> statement-breakpoint
ALTER TABLE `registry_module_versions` ADD `vcs_tag` text;--> statement-breakpoint
ALTER TABLE `registry_module_versions` ADD `vcs_branch` text;--> statement-breakpoint
ALTER TABLE `registry_module_versions` ADD `source_directory` text;--> statement-breakpoint
ALTER TABLE `registry_module_versions` ADD `metadata` text;--> statement-breakpoint
ALTER TABLE `registry_module_versions` ADD `ingest_error` text;--> statement-breakpoint
ALTER TABLE `registry_module_versions` ADD `published_at` integer;--> statement-breakpoint
ALTER TABLE `registry_module_versions` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `registry_modules` ADD `description` text;--> statement-breakpoint
ALTER TABLE `registry_modules` ADD `publishing_mechanism` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `registry_modules` ADD `publishing_workflow` text;--> statement-breakpoint
ALTER TABLE `registry_modules` ADD `vcs_connection_type` text;--> statement-breakpoint
ALTER TABLE `registry_modules` ADD `vcs_connection_id` text;--> statement-breakpoint
ALTER TABLE `registry_modules` ADD `repository_identifier` text;--> statement-breakpoint
ALTER TABLE `registry_modules` ADD `repository_display_identifier` text;--> statement-breakpoint
ALTER TABLE `registry_modules` ADD `repository_url` text;--> statement-breakpoint
ALTER TABLE `registry_modules` ADD `source_directory` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `registry_modules` ADD `tag_prefix` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `registry_modules` ADD `branch` text;--> statement-breakpoint
ALTER TABLE `registry_modules` ADD `status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `registry_modules` ADD `last_successful_sync_at` integer;--> statement-breakpoint
ALTER TABLE `registry_modules` ADD `last_sync_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `registry_modules` ADD `last_sync_error` text;--> statement-breakpoint
ALTER TABLE `registry_modules` ADD `updated_at` integer;