CREATE TABLE `no_code_modules` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`version_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `registry_modules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `registry_module_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `no_code_modules_module_idx` ON `no_code_modules` (`module_id`);
