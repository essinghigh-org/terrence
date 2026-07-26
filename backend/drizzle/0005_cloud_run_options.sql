ALTER TABLE `configuration_versions` ADD `speculative` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `configuration_versions` ADD `provisional` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `plan_only` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `refresh` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `refresh_only` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `target_addrs` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `replace_addrs` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `variables` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `log_token` text;