ALTER TABLE `agent_jobs` ADD `iac_binary` text DEFAULT 'terraform' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `iac_binaries` text DEFAULT '["terraform"]' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `configuration_versions_workspace_created_idx` ON `configuration_versions` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `runs_workspace_status_created_idx` ON `runs` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `runs_status_created_idx` ON `runs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workspaces_org_idx` ON `workspaces` (`org_id`);