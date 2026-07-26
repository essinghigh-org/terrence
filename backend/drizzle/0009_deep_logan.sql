CREATE TABLE `registry_module_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`version` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`archive_path` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `registry_modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_module_versions_mod_ver_idx` ON `registry_module_versions` (`module_id`,`version`);--> statement-breakpoint
CREATE TABLE `registry_modules` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`namespace` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_modules_ns_name_provider_idx` ON `registry_modules` (`namespace`,`name`,`provider`);--> statement-breakpoint
CREATE TABLE `registry_provider_platforms` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`os` text NOT NULL,
	`arch` text NOT NULL,
	`filename` text NOT NULL,
	`download_url` text NOT NULL,
	`shasum` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `registry_provider_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_provider_platforms_ver_os_arch_idx` ON `registry_provider_platforms` (`version_id`,`os`,`arch`);--> statement-breakpoint
CREATE TABLE `registry_provider_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`version` text NOT NULL,
	`protocols` text DEFAULT '["5.0"]',
	`shasums_url` text,
	`shasums_signature_url` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `registry_providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_provider_versions_prov_ver_idx` ON `registry_provider_versions` (`provider_id`,`version`);--> statement-breakpoint
CREATE TABLE `registry_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`namespace` text NOT NULL,
	`type` text NOT NULL,
	`registry_name` text DEFAULT 'private' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_providers_ns_type_idx` ON `registry_providers` (`namespace`,`type`);