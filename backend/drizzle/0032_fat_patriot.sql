CREATE TABLE `registry_components` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`namespace` text DEFAULT 'hashicorp' NOT NULL,
	`description` text,
	`source` text DEFAULT 'registry' NOT NULL,
	`source_identifier` text NOT NULL,
	`version` text DEFAULT '0.1.0' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_components_org_ns_name_idx` ON `registry_components` (`org_id`,`namespace`,`name`);