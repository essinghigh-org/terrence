ALTER TABLE `scim_settings` ADD `site_auditor_group_scim_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `scim_site_auditor` integer DEFAULT false NOT NULL;