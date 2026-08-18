CREATE TABLE `durable_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`dedupe_key` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_after` integer NOT NULL,
	`locked_by` text,
	`lock_token` text,
	`lease_expires_at` integer,
	`heartbeat_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `durable_jobs_kind_status_run_after_idx` ON `durable_jobs` (`kind`,`status`,`run_after`);--> statement-breakpoint
CREATE INDEX `durable_jobs_kind_dedupe_idx` ON `durable_jobs` (`kind`,`dedupe_key`,`status`);--> statement-breakpoint
CREATE INDEX `durable_jobs_lease_idx` ON `durable_jobs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `explorer_catalog_items` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`version` text NOT NULL,
	`workspace_count` integer DEFAULT 0 NOT NULL,
	`workspaces` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `explorer_catalog_org_kind_key_idx` ON `explorer_catalog_items` (`org_id`,`kind`,`name`,`source`,`version`);--> statement-breakpoint
CREATE INDEX `explorer_catalog_org_kind_idx` ON `explorer_catalog_items` (`org_id`,`kind`,`name`);--> statement-breakpoint
CREATE TABLE `explorer_workspace_inventory` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`workspace_name` text NOT NULL,
	`workspace_created_at` integer NOT NULL,
	`workspace_updated_at` integer NOT NULL,
	`terraform_version` text,
	`execution_mode` text,
	`vcs_repo_identifier` text,
	`project_id` text,
	`project_name` text,
	`current_run_status` text,
	`current_run_applied_at` integer,
	`current_run_external_id` text,
	`current_resource_count` integer DEFAULT 0 NOT NULL,
	`drifted` integer,
	`resources_drifted` integer DEFAULT 0 NOT NULL,
	`resources_undrifted` integer DEFAULT 0 NOT NULL,
	`all_checks_succeeded` integer,
	`checks_passed` integer DEFAULT 0 NOT NULL,
	`checks_failed` integer DEFAULT 0 NOT NULL,
	`checks_errored` integer DEFAULT 0 NOT NULL,
	`checks_unknown` integer DEFAULT 0 NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	`providers` text DEFAULT '' NOT NULL,
	`modules` text DEFAULT '' NOT NULL,
	`provider_items` text DEFAULT '[]' NOT NULL,
	`module_items` text DEFAULT '[]' NOT NULL,
	`provider_count` integer DEFAULT 0 NOT NULL,
	`module_count` integer DEFAULT 0 NOT NULL,
	`state_version_terraform_version` text,
	`state_serial` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `explorer_inventory_org_name_idx` ON `explorer_workspace_inventory` (`org_id`,`workspace_name`);--> statement-breakpoint
CREATE INDEX `explorer_inventory_org_updated_idx` ON `explorer_workspace_inventory` (`org_id`,`workspace_updated_at`);--> statement-breakpoint
CREATE TABLE `workload_identity_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`key_id` text NOT NULL,
	`encrypted_private_key` text NOT NULL,
	`public_jwk` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`retired_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workload_identity_keys_key_id_unique` ON `workload_identity_keys` (`key_id`);--> statement-breakpoint
CREATE TABLE `workload_identity_tokens` (
	`jti` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`key_id` text NOT NULL,
	`audience` text NOT NULL,
	`subject` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `workload_identity_tokens_run_idx` ON `workload_identity_tokens` (`run_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `workload_identity_tokens_expiry_idx` ON `workload_identity_tokens` (`expires_at`,`revoked_at`);--> statement-breakpoint
ALTER TABLE `module_test_runs` ADD `oidc_token_generated_at` integer;--> statement-breakpoint
ALTER TABLE `module_test_runs` ADD `oidc_token_expires_at` integer;--> statement-breakpoint
ALTER TABLE `organizations` ADD `module_test_token_ttl` integer DEFAULT 600 NOT NULL;--> statement-breakpoint
ALTER TABLE `stacks` ADD `trigger_disabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `stacks` ADD `debugging_mode` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `stacks` ADD `vcs_service_provider` text;--> statement-breakpoint
ALTER TABLE `stacks` ADD `vcs_tags_regex` text;--> statement-breakpoint
ALTER TABLE `stacks` ADD `vcs_display_identifier` text;--> statement-breakpoint
ALTER TABLE `stacks` ADD `vcs_repository_http_url` text;--> statement-breakpoint
ALTER TABLE `stacks` ADD `vcs_sparse_checkout_pattern` text;