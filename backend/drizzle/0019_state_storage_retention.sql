ALTER TABLE `data_retention_policies` ADD `delete_older_than_n_days` integer;
--> statement-breakpoint
ALTER TABLE `configuration_versions` ADD `soft_deleted_at` integer;
--> statement-breakpoint
ALTER TABLE `configuration_versions` ADD `created_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `configuration_versions` SET `created_at` = (strftime('%s', 'now') * 1000) WHERE `created_at` = 0;
--> statement-breakpoint
ALTER TABLE `state_versions` ADD `intermediate` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `state_versions` ADD `soft_deleted_at` integer;
