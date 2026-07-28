CREATE TABLE `agent_pool_allowed_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_pool_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_pool_allowed_workspaces_pool_workspace_idx` ON `agent_pool_allowed_workspaces` (`agent_pool_id`,`workspace_id`);
--> statement-breakpoint
CREATE TABLE `agent_pool_allowed_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_pool_id` text NOT NULL,
	`project_id` text NOT NULL,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_pool_allowed_projects_pool_project_idx` ON `agent_pool_allowed_projects` (`agent_pool_id`,`project_id`);
