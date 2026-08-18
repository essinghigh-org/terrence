CREATE TABLE `explorer_catalog_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`version` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `explorer_catalog_membership_workspace_key_idx` ON `explorer_catalog_memberships` (`workspace_id`,`kind`,`name`,`source`,`version`);--> statement-breakpoint
CREATE INDEX `explorer_catalog_membership_org_key_idx` ON `explorer_catalog_memberships` (`org_id`,`kind`,`name`,`source`,`version`);--> statement-breakpoint
CREATE INDEX `explorer_catalog_membership_workspace_idx` ON `explorer_catalog_memberships` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `stack_agent_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`stack_id` text NOT NULL,
	`deployment_run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`agent_pool_id` text NOT NULL,
	`agent_id` text,
	`phase` text NOT NULL,
	`iac_binary` text DEFAULT 'terraform' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`result` text,
	`error_message` text,
	`claimed_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stack_agent_jobs_step_phase_idx` ON `stack_agent_jobs` (`step_id`,`phase`);--> statement-breakpoint
CREATE INDEX `stack_agent_jobs_pool_status_created_idx` ON `stack_agent_jobs` (`agent_pool_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `stack_agent_jobs_run_status_idx` ON `stack_agent_jobs` (`deployment_run_id`,`status`);--> statement-breakpoint
CREATE TABLE `stack_state_locks` (
	`id` text PRIMARY KEY NOT NULL,
	`stack_id` text NOT NULL,
	`deployment` text NOT NULL,
	`run_id` text,
	`fencing_token` integer DEFAULT 0 NOT NULL,
	`acquired_at` integer,
	`released_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stack_state_locks_stack_deployment_idx` ON `stack_state_locks` (`stack_id`,`deployment`);--> statement-breakpoint
CREATE INDEX `stack_state_locks_run_idx` ON `stack_state_locks` (`run_id`);--> statement-breakpoint
CREATE TABLE `workload_identity_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text,
	`lease_expires_at` integer,
	`fencing_token` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `module_test_runs` ADD `execution_pid` integer;--> statement-breakpoint
ALTER TABLE `module_test_runs` ADD `execution_started_at` integer;--> statement-breakpoint
ALTER TABLE `module_test_runs` ADD `execution_stage` text;--> statement-breakpoint
ALTER TABLE `module_test_runs` ADD `execution_directory` text;--> statement-breakpoint
ALTER TABLE `module_test_runs` ADD `execution_result_path` text;--> statement-breakpoint
ALTER TABLE `module_test_runs` ADD `execution_token_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `stacks` ADD `execution_mode` text DEFAULT 'remote' NOT NULL;