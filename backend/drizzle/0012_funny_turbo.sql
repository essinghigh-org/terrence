ALTER TABLE `module_test_configurations` ADD `oidc_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `module_test_configurations` ADD `oidc_provider` text;--> statement-breakpoint
ALTER TABLE `module_test_configurations` ADD `oidc_configuration` text;