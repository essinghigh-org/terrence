ALTER TABLE `organizations` ADD `global_module_sharing` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `organizations` ADD `global_provider_sharing` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE `registry_partnerships` (
	`id` text PRIMARY KEY NOT NULL,
	`producer_org_id` text NOT NULL,
	`consumer_org_id` text NOT NULL,
	`modules` integer DEFAULT false NOT NULL,
	`providers` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`producer_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`consumer_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_partnerships_producer_consumer_idx` ON `registry_partnerships` (`producer_org_id`,`consumer_org_id`);
