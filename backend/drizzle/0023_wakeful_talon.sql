ALTER TABLE `runs` ADD `invoke_action_addrs` text;--> statement-breakpoint
UPDATE `team_projects` SET `organization_id` = (
	SELECT `teams`.`org_id` FROM `teams` WHERE `teams`.`id` = `team_projects`.`team_id`
) WHERE `organization_id` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_id_org_idx` ON `projects` (`id`,`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `teams_id_org_idx` ON `teams` (`id`,`org_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_team_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text,
	`access` text DEFAULT 'read' NOT NULL,
	`project_access` text,
	`workspace_access` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`,`organization_id`) REFERENCES `teams`(`id`,`org_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`organization_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_team_projects`("id", "team_id", "project_id", "organization_id", "access", "project_access", "workspace_access", "created_at") SELECT "id", "team_id", "project_id", "organization_id", "access", "project_access", "workspace_access", "created_at" FROM `team_projects`;--> statement-breakpoint
DROP TABLE `team_projects`;--> statement-breakpoint
ALTER TABLE `__new_team_projects` RENAME TO `team_projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `team_projects_team_project_idx` ON `team_projects` (`team_id`,`project_id`);