CREATE TABLE `organization_data_retention_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`state_versions_count` integer,
	`delete_older_than_n_days` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_data_retention_policies_organization_id_unique` ON `organization_data_retention_policies` (`organization_id`);
