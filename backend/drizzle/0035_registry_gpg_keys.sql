CREATE TABLE `registry_gpg_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`namespace` text NOT NULL,
	`key_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`ascii_armor` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`source_url` text,
	`trust_signature` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_gpg_keys_namespace_key_idx` ON `registry_gpg_keys` (`namespace`,`key_id`);
--> statement-breakpoint
ALTER TABLE `registry_module_versions` ADD `key_id` text;
--> statement-breakpoint
ALTER TABLE `registry_provider_versions` ADD `key_id` text;
