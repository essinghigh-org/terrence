CREATE INDEX `agents_last_ping_at_status_idx` ON `agents` (`last_ping_at`,`status`);--> statement-breakpoint
CREATE INDEX `audit_logs_created_at_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_org_created_at_idx` ON `audit_logs` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_resource_idx` ON `audit_logs` (`resource_type`,`resource_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `run_comments_run_created_idx` ON `run_comments` (`run_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_variables_workspace_key_idx` ON `workspace_variables` (`workspace_id`,`category`,`key`);