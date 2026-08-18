CREATE TABLE `module_test_configuration_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`archive_path` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`uploaded_at` integer,
	FOREIGN KEY (`module_id`) REFERENCES `registry_modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `module_test_configuration_versions_module_created_idx` ON `module_test_configuration_versions` (`module_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `module_test_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`version_id` text NOT NULL,
	`configuration_version_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`test_status` text,
	`tests_passed` integer,
	`tests_failed` integer,
	`tests_errored` integer,
	`tests_skipped` integer,
	`verbose` integer DEFAULT false NOT NULL,
	`filters` text DEFAULT '[]' NOT NULL,
	`test_directory` text DEFAULT 'tests' NOT NULL,
	`variables` text DEFAULT '[]' NOT NULL,
	`source` text DEFAULT 'tfe-api' NOT NULL,
	`message` text,
	`output` text,
	`error` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `registry_modules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `registry_module_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`configuration_version_id`) REFERENCES `module_test_configuration_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `module_test_runs_module_created_idx` ON `module_test_runs` (`module_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `module_test_runs_version_created_idx` ON `module_test_runs` (`version_id`,`created_at`);