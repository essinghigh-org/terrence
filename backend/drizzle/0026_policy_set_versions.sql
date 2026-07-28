CREATE TABLE `policy_set_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_set_id` text NOT NULL,
	`source` text DEFAULT 'tfe-api' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`status_timestamps` text DEFAULT '{}' NOT NULL,
	`error` text,
	`archive_path` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`policy_set_id`) REFERENCES `policy_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `policy_set_versions_set_created_idx` ON `policy_set_versions` (`policy_set_id`,`created_at`);
