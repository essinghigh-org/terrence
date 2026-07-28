ALTER TABLE `policy_sets` ADD `policy_update_patterns` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `policy_set_versions` ADD `ingress_attributes` text;
--> statement-breakpoint
ALTER TABLE `policies` ADD `policy_set_version_id` text REFERENCES `policy_set_versions`(`id`) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `policies` ADD `source` text;
--> statement-breakpoint
ALTER TABLE `policies` ADD `source_path` text;
