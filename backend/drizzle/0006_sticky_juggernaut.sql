ALTER TABLE `runs` ADD `terraform_version` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `debugging_mode` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `created_by` text REFERENCES users(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `source_name` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `source_url` text;
