CREATE TABLE `reserved_tag_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`key` text NOT NULL,
	`disable_overrides` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reserved_tag_keys_org_key_idx` ON `reserved_tag_keys` (`org_id`,`key`);
