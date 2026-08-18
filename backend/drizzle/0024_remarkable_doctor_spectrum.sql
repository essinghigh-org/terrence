CREATE TABLE `agent_forwarded_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_pool_id` text NOT NULL,
	`agent_id` text,
	`method` text NOT NULL,
	`url` text NOT NULL,
	`headers` text DEFAULT '{}' NOT NULL,
	`body` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`response_status` integer,
	`response_headers` text,
	`response_body` text,
	`error_message` text,
	`claimed_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_forwarded_requests_pool_status_created_idx` ON `agent_forwarded_requests` (`agent_pool_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `notification_workspace_counters` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`configuration_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `accept` text DEFAULT 'plan,apply,policy,assessment,stack_prepare,stack_plan,stack_apply,source_bundle,stack_aggregate_outputs,test' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `request_forwarding` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `hyok` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `control_plane_nodes` ADD `readiness_checks` text DEFAULT '[]' NOT NULL;