PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_configurations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`team_id` text,
	`project_id` text,
	`name` text NOT NULL,
	`destination_type` text NOT NULL,
	`url` text NOT NULL,
	`email_addresses` text,
	`email_all_members` integer DEFAULT false NOT NULL,
	`email_user_ids` text,
	`triggers` text NOT NULL,
	`enabled` integer DEFAULT false,
	`token` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_notification_configurations`("id", "workspace_id", "team_id", "project_id", "name", "destination_type", "url", "email_addresses", "email_all_members", "email_user_ids", "triggers", "enabled", "token", "created_at") SELECT "id", "workspace_id", "team_id", "project_id", "name", "destination_type", "url", "email_addresses", "email_all_members", "email_user_ids", "triggers", "enabled", "token", "created_at" FROM `notification_configurations`;--> statement-breakpoint
DROP TABLE `notification_configurations`;--> statement-breakpoint
ALTER TABLE `__new_notification_configurations` RENAME TO `notification_configurations`;--> statement-breakpoint
CREATE TABLE `__new_organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`default_iac_binary` text DEFAULT 'terraform',
	`default_terraform_version` text DEFAULT 'latest',
	`cost_estimation_enabled` integer DEFAULT false NOT NULL,
	`session_timeout` integer,
	`session_remember` integer,
	`collaborator_auth_policy` text DEFAULT 'password' NOT NULL,
	`user_tokens_enabled` integer DEFAULT true NOT NULL,
	`default_agent_pool_id` text,
	`assessments_enforced` integer DEFAULT false NOT NULL,
	`global_module_sharing` integer DEFAULT false NOT NULL,
	`global_provider_sharing` integer DEFAULT false NOT NULL,
	`access_beta_tools` integer DEFAULT false NOT NULL,
	`workspace_limit` integer,
	`saml_enabled` integer DEFAULT false NOT NULL,
	`owners_team_saml_role_id` text,
	`allow_force_delete_workspaces` integer DEFAULT true NOT NULL,
	`stacks_enabled` integer DEFAULT false NOT NULL,
	`show_pre_releases` integer DEFAULT false NOT NULL,
	`default_execution_mode` text DEFAULT 'remote',
	`aggregated_commit_status_enabled` integer DEFAULT true NOT NULL,
	`send_passing_statuses` integer DEFAULT false NOT NULL,
	`module_test_token_ttl` integer DEFAULT 600 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_organizations`("id", "name", "email", "default_iac_binary", "default_terraform_version", "cost_estimation_enabled", "session_timeout", "session_remember", "collaborator_auth_policy", "user_tokens_enabled", "default_agent_pool_id", "assessments_enforced", "global_module_sharing", "global_provider_sharing", "access_beta_tools", "workspace_limit", "saml_enabled", "owners_team_saml_role_id", "allow_force_delete_workspaces", "stacks_enabled", "show_pre_releases", "default_execution_mode", "aggregated_commit_status_enabled", "send_passing_statuses", "module_test_token_ttl") SELECT "id", "name", "email", "default_iac_binary", "default_terraform_version", "cost_estimation_enabled", "session_timeout", "session_remember", "collaborator_auth_policy", "user_tokens_enabled", "default_agent_pool_id", "assessments_enforced", "global_module_sharing", "global_provider_sharing", "access_beta_tools", "workspace_limit", "saml_enabled", "owners_team_saml_role_id", "allow_force_delete_workspaces", "stacks_enabled", "show_pre_releases", "default_execution_mode", "aggregated_commit_status_enabled", "send_passing_statuses", "module_test_token_ttl" FROM `organizations`;--> statement-breakpoint
DROP TABLE `organizations`;--> statement-breakpoint
ALTER TABLE `__new_organizations` RENAME TO `organizations`;--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_name_unique` ON `organizations` (`name`);--> statement-breakpoint
CREATE TABLE `__new_policy_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text DEFAULT 'sentinel' NOT NULL,
	`global` integer DEFAULT false,
	`overridable` integer DEFAULT false,
	`agent_enabled` integer DEFAULT false,
	`policy_tool_version` text,
	`policies_path` text,
	`vcs_repo` text,
	`policy_update_patterns` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_policy_sets`("id", "org_id", "name", "description", "kind", "global", "overridable", "agent_enabled", "policy_tool_version", "policies_path", "vcs_repo", "policy_update_patterns", "created_at") SELECT "id", "org_id", "name", "description", "kind", "global", "overridable", "agent_enabled", "policy_tool_version", "policies_path", "vcs_repo", "policy_update_patterns", "created_at" FROM `policy_sets`;--> statement-breakpoint
DROP TABLE `policy_sets`;--> statement-breakpoint
ALTER TABLE `__new_policy_sets` RENAME TO `policy_sets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;