CREATE TABLE `run_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`user_id` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `policy_set_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_set_id` text NOT NULL,
	`project_id` text NOT NULL,
	FOREIGN KEY (`policy_set_id`) REFERENCES `policy_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_set_projects_idx` ON `policy_set_projects` (`policy_set_id`,`project_id`);
--> statement-breakpoint
CREATE TABLE `policy_set_exclusions` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_set_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`policy_set_id`) REFERENCES `policy_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_set_exclusions_idx` ON `policy_set_exclusions` (`policy_set_id`,`workspace_id`);
--> statement-breakpoint
CREATE TABLE `policy_set_parameters` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_set_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`sensitive` integer DEFAULT 0,
	`hcl` integer DEFAULT 0,
	FOREIGN KEY (`policy_set_id`) REFERENCES `policy_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_client_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`oauth_client_id` text NOT NULL,
	`project_id` text NOT NULL,
	FOREIGN KEY (`oauth_client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_client_projects_idx` ON `oauth_client_projects` (`oauth_client_id`,`project_id`);
--> statement-breakpoint
CREATE TABLE `agent_pools` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`organization_scoped` integer DEFAULT 1,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_pool_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_pool_id` text NOT NULL,
	`token` text NOT NULL UNIQUE,
	`description` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `run_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`url` text NOT NULL,
	`category` text DEFAULT 'general',
	`enabled` integer DEFAULT 1,
	`hmac_key` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspace_run_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_task_id` text NOT NULL,
	`stage` text DEFAULT 'post_plan' NOT NULL,
	`enforcement_level` text DEFAULT 'advisory' NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_task_id`) REFERENCES `run_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_run_tasks_idx` ON `workspace_run_tasks` (`workspace_id`,`run_task_id`);
--> statement-breakpoint
CREATE TABLE `run_task_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`run_task_id` text NOT NULL,
	`status` text DEFAULT 'passed' NOT NULL,
	`message` text,
	`url` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_task_id`) REFERENCES `run_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`user_id` text,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`details` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
