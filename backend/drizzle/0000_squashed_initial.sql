CREATE TABLE `admin_general_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`limit_user_organization_creation` integer DEFAULT true NOT NULL,
	`api_rate_limiting_enabled` integer DEFAULT true NOT NULL,
	`api_rate_limit` integer DEFAULT 30 NOT NULL,
	`plan_timeout` text DEFAULT '2h' NOT NULL,
	`apply_timeout` text DEFAULT '24h' NOT NULL,
	`send_passing_statuses` integer DEFAULT false NOT NULL,
	`allow_speculative_plans_forks` integer DEFAULT false NOT NULL,
	`default_remote_state_access` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `admin_opa_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`url` text,
	`sha` text,
	`deprecated` integer DEFAULT false,
	`enabled` integer DEFAULT true,
	`is_default` integer DEFAULT false,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_opa_versions_version_unique` ON `admin_opa_versions` (`version`);--> statement-breakpoint
CREATE TABLE `admin_sentinel_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`url` text,
	`sha` text,
	`deprecated` integer DEFAULT false,
	`enabled` integer DEFAULT true,
	`is_default` integer DEFAULT false,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_sentinel_versions_version_unique` ON `admin_sentinel_versions` (`version`);--> statement-breakpoint
CREATE TABLE `admin_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`values` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `admin_terraform_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`url` text,
	`sha` text,
	`deprecated` integer DEFAULT false,
	`enabled` integer DEFAULT true,
	`is_default` integer DEFAULT false,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_terraform_versions_version_unique` ON `admin_terraform_versions` (`version`);--> statement-breakpoint
CREATE TABLE `agent_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`agent_pool_id` text NOT NULL,
	`agent_id` text,
	`phase` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`result` text,
	`error_message` text,
	`claimed_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_jobs_run_phase_idx` ON `agent_jobs` (`run_id`,`phase`);--> statement-breakpoint
CREATE INDEX `agent_jobs_pool_status_created_idx` ON `agent_jobs` (`agent_pool_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_pool_allowed_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_pool_id` text NOT NULL,
	`project_id` text NOT NULL,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_pool_allowed_projects_pool_project_idx` ON `agent_pool_allowed_projects` (`agent_pool_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `agent_pool_allowed_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_pool_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_pool_allowed_workspaces_pool_workspace_idx` ON `agent_pool_allowed_workspaces` (`agent_pool_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `agent_pool_excluded_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_pool_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_pool_excluded_workspaces_pool_workspace_idx` ON `agent_pool_excluded_workspaces` (`agent_pool_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `agent_pool_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_pool_id` text NOT NULL,
	`token` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_pool_tokens_token_unique` ON `agent_pool_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `agent_pools` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`organization_scoped` integer DEFAULT true,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_pool_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`ip_address` text,
	`version` text,
	`architecture` text,
	`last_ping_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`user_id` text,
	`org_id` text,
	`team_id` text,
	`description` text,
	`scopes` text,
	`token_type` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_unique` ON `api_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `check_results` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`assessment_result_id` text,
	`run_id` text,
	`address` text NOT NULL,
	`kind` text DEFAULT 'check' NOT NULL,
	`status` text NOT NULL,
	`message` text,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assessment_result_id`) REFERENCES `assessment_results`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `check_results_assessment_idx` ON `check_results` (`assessment_result_id`);--> statement-breakpoint
CREATE INDEX `check_results_run_idx` ON `check_results` (`run_id`);--> statement-breakpoint
CREATE TABLE `assessment_results` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`succeeded` integer,
	`drifted` integer,
	`error_message` text,
	`resources_drifted` integer DEFAULT 0 NOT NULL,
	`resources_undrifted` integer DEFAULT 0 NOT NULL,
	`all_checks_succeeded` integer,
	`checks_passed` integer DEFAULT 0 NOT NULL,
	`checks_failed` integer DEFAULT 0 NOT NULL,
	`checks_errored` integer DEFAULT 0 NOT NULL,
	`checks_unknown` integer DEFAULT 0 NOT NULL,
	`json_output` text,
	`json_schema` text,
	`log_output` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `assessment_results_workspace_created_idx` ON `assessment_results` (`workspace_id`,`created_at`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `change_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`subject` text NOT NULL,
	`message` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_by` text,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `change_requests_workspace_created_idx` ON `change_requests` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `cidr_range_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`enforcement_scope` text DEFAULT 'organization' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `cidr_ranges` (
	`id` text PRIMARY KEY NOT NULL,
	`cidr_range_list_id` text NOT NULL,
	`value` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`cidr_range_list_id`) REFERENCES `cidr_range_lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `configuration_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`auto_queue_runs` integer DEFAULT true NOT NULL,
	`archive_path` text,
	`speculative` integer DEFAULT false NOT NULL,
	`provisional` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'tfe-api',
	`ingress_attributes` text,
	`status_timestamps` text,
	`error` text,
	`error_message` text,
	`soft_deleted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `data_retention_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`state_versions_count` integer,
	`delete_older_than_n_days` integer,
	`auto_destroy_at` text,
	`auto_destroy_activity_duration` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `data_retention_policies_workspace_id_unique` ON `data_retention_policies` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `github_app_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`installation_id` integer NOT NULL,
	`icon_url` text,
	`installation_type` text DEFAULT 'Organization',
	`installation_url` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_app_installations_org_installation_idx` ON `github_app_installations` (`org_id`,`installation_id`);--> statement-breakpoint
CREATE TABLE `github_webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer
);
--> statement-breakpoint
CREATE TABLE `hyok_configurations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`kek_id` text NOT NULL,
	`kms_options` text,
	`agent_pool_id` text,
	`oidc_config_id` text NOT NULL,
	`oidc_config_type` text NOT NULL,
	`is_primary` integer DEFAULT false,
	`status` text DEFAULT 'ok' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `hyok_customer_key_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`hyok_config_id` text NOT NULL,
	`key_version` text NOT NULL,
	`encrypted_dek` text NOT NULL,
	`customer_key_name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`workspaces_secured` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`hyok_config_id`) REFERENCES `hyok_configurations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `logs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`phase` text NOT NULL,
	`output_text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `logs_run_phase_idx` ON `logs` (`run_id`,`phase`);--> statement-breakpoint
CREATE TABLE `module_test_configurations` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`oidc_provider_url` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `registry_modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `module_test_results` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`output` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `registry_module_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `no_code_modules` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`version_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `registry_modules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `registry_module_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `no_code_modules_module_idx` ON `no_code_modules` (`module_id`);--> statement-breakpoint
CREATE TABLE `no_code_variable_options` (
	`id` text PRIMARY KEY NOT NULL,
	`no_code_module_id` text NOT NULL,
	`variable_name` text NOT NULL,
	`variable_type` text NOT NULL,
	`options` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`no_code_module_id`) REFERENCES `no_code_modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `no_code_variable_options_module_name_idx` ON `no_code_variable_options` (`no_code_module_id`,`variable_name`);--> statement-breakpoint
CREATE TABLE `no_code_workspace_configurations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`no_code_module_id` text,
	`module_id` text,
	`module_version_id` text,
	`configuration_version_id` text,
	`module_source` text NOT NULL,
	`module_version` text NOT NULL,
	`inputs` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`no_code_module_id`) REFERENCES `no_code_modules`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`module_id`) REFERENCES `registry_modules`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`module_version_id`) REFERENCES `registry_module_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`configuration_version_id`) REFERENCES `configuration_versions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `no_code_workspace_configurations_workspace_idx` ON `no_code_workspace_configurations` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `no_code_workspace_configurations_module_idx` ON `no_code_workspace_configurations` (`no_code_module_id`);--> statement-breakpoint
CREATE TABLE `notification_configurations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`team_id` text,
	`project_id` text,
	`name` text NOT NULL,
	`destination_type` text NOT NULL,
	`url` text NOT NULL,
	`triggers` text NOT NULL,
	`enabled` integer DEFAULT true,
	`token` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
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
CREATE UNIQUE INDEX `oauth_client_projects_idx` ON `oauth_client_projects` (`oauth_client_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`agent_pool_id` text,
	`name` text NOT NULL,
	`service_provider` text DEFAULT 'github' NOT NULL,
	`api_url` text,
	`http_url` text,
	`key` text,
	`secret` text,
	`rsa_public_key` text,
	`organization_scoped` integer DEFAULT false,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `oauth_device_codes` (
	`device_code` text PRIMARY KEY NOT NULL,
	`user_code` text NOT NULL,
	`user_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`token` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_device_codes_user_code_unique` ON `oauth_device_codes` (`user_code`);--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`oauth_client_id` text NOT NULL,
	`service_provider_user` text,
	`token` text NOT NULL,
	`has_ssh_key` integer DEFAULT false,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`oauth_client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oidc_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`config_type` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `org_token_ttl_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`token_type` text NOT NULL,
	`max_ttl_ms` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_token_ttl_policies_org_type_idx` ON `org_token_ttl_policies` (`org_id`,`token_type`);--> statement-breakpoint
CREATE TABLE `organization_data_retention_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`state_versions_count` integer,
	`delete_older_than_n_days` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_data_retention_policies_organization_id_unique` ON `organization_data_retention_policies` (`organization_id`);--> statement-breakpoint
CREATE TABLE `organization_membership_roles` (
	`membership_id` text NOT NULL,
	`role_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`membership_id`) REFERENCES `organization_memberships`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `organization_roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_membership_roles_membership_role_idx` ON `organization_membership_roles` (`membership_id`,`role_id`);--> statement-breakpoint
CREATE TABLE `organization_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`sso_source` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `organization_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`permissions` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_roles_org_name_idx` ON `organization_roles` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`default_iac_binary` text DEFAULT 'tofu',
	`default_terraform_version` text DEFAULT 'latest',
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
	`send_passing_statuses` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_name_unique` ON `organizations` (`name`);--> statement-breakpoint
CREATE TABLE `plan_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`data_type` text DEFAULT 'sentinel-mock-bundle-v0' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`download_url` text,
	`expires_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`policy_set_id` text,
	`policy_set_version_id` text,
	`name` text NOT NULL,
	`description` text,
	`enforcement_level` text DEFAULT 'soft-mandatory' NOT NULL,
	`query` text,
	`source` text,
	`source_path` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`policy_set_id`) REFERENCES `policy_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`policy_set_version_id`) REFERENCES `policy_set_versions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `policy_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`policy_id` text,
	`policy_set_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`policy_set_id`) REFERENCES `policy_sets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `policy_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`task_stage_id` text,
	`run_id` text,
	`status` text DEFAULT 'passed' NOT NULL,
	`policy_kind` text DEFAULT 'opa',
	`policy_tool_version` text DEFAULT '0.44.0',
	`result_count` text,
	`status_timestamps` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_stage_id`) REFERENCES `task_stages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `policy_set_exclusions` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_set_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`policy_set_id`) REFERENCES `policy_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_set_exclusions_idx` ON `policy_set_exclusions` (`policy_set_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `policy_set_outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_evaluation_id` text NOT NULL,
	`policy_set_name` text,
	`policy_name` text,
	`enforcement_level` text DEFAULT 'advisory' NOT NULL,
	`status` text DEFAULT 'passed' NOT NULL,
	`query` text,
	`description` text,
	`error` text,
	`overridable` integer DEFAULT false,
	`result_count` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`policy_evaluation_id`) REFERENCES `policy_evaluations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `policy_set_parameters` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_set_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`sensitive` integer DEFAULT false,
	`hcl` integer DEFAULT false,
	FOREIGN KEY (`policy_set_id`) REFERENCES `policy_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `policy_set_project_exclusions` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_set_id` text NOT NULL,
	`project_id` text NOT NULL,
	FOREIGN KEY (`policy_set_id`) REFERENCES `policy_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_set_project_exclusions_idx` ON `policy_set_project_exclusions` (`policy_set_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `policy_set_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_set_id` text NOT NULL,
	`project_id` text NOT NULL,
	FOREIGN KEY (`policy_set_id`) REFERENCES `policy_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_set_projects_idx` ON `policy_set_projects` (`policy_set_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `policy_set_tag_selectors` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_set_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`is_exclude` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`policy_set_id`) REFERENCES `policy_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `policy_set_tag_selectors_pset_idx` ON `policy_set_tag_selectors` (`policy_set_id`);--> statement-breakpoint
CREATE TABLE `policy_set_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_set_id` text NOT NULL,
	`source` text DEFAULT 'tfe-api' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`status_timestamps` text DEFAULT '{}' NOT NULL,
	`ingress_attributes` text,
	`error` text,
	`archive_path` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`policy_set_id`) REFERENCES `policy_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `policy_set_versions_set_created_idx` ON `policy_set_versions` (`policy_set_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `policy_set_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_set_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`policy_set_id`) REFERENCES `policy_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_set_workspaces_idx` ON `policy_set_workspaces` (`policy_set_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `policy_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text DEFAULT 'sentinel' NOT NULL,
	`global` integer DEFAULT false,
	`overridable` integer DEFAULT true,
	`agent_enabled` integer DEFAULT false,
	`policy_tool_version` text,
	`policies_path` text,
	`vcs_repo` text,
	`policy_update_patterns` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `project_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_tags_project_key_idx` ON `project_tags` (`project_id`,`key`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`default_execution_mode` text DEFAULT 'remote',
	`auto_destroy_activity_duration` text,
	`setting_overwrites` text,
	`default_agent_pool_id` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_org_name_idx` ON `projects` (`org_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_org_default_idx` ON `projects` (`org_id`) WHERE "projects"."is_default" = 1;--> statement-breakpoint
CREATE TABLE `provider_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`provider_source` text NOT NULL,
	`configuration_hcl` text,
	`global` integer DEFAULT false,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_sets_org_name_idx` ON `provider_sets` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `query_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source` text DEFAULT 'tfe-api' NOT NULL,
	`variables` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`log_read_url` text,
	`status_timestamps` text,
	`created_by` text,
	`canceled_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`canceled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `refresh_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token_id` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`rotated_at` integer,
	`revoked_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_sessions_token_hash_unique` ON `refresh_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `refresh_sessions_family_idx` ON `refresh_sessions` (`family_id`);--> statement-breakpoint
CREATE INDEX `refresh_sessions_user_idx` ON `refresh_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `registry_gpg_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`namespace` text NOT NULL,
	`key_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`ascii_armor` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`source_url` text,
	`trust_signature` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_gpg_keys_namespace_key_idx` ON `registry_gpg_keys` (`namespace`,`key_id`);--> statement-breakpoint
CREATE TABLE `registry_module_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`version` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`archive_path` text,
	`key_id` text,
	`is_deprecated` integer DEFAULT false,
	`is_revoked` integer DEFAULT false,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `registry_modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_module_versions_mod_ver_idx` ON `registry_module_versions` (`module_id`,`version`);--> statement-breakpoint
CREATE TABLE `registry_modules` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`namespace` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_modules_ns_name_provider_idx` ON `registry_modules` (`namespace`,`name`,`provider`);--> statement-breakpoint
CREATE TABLE `registry_partnerships` (
	`id` text PRIMARY KEY NOT NULL,
	`producer_org_id` text NOT NULL,
	`consumer_org_id` text NOT NULL,
	`modules` integer DEFAULT false NOT NULL,
	`providers` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`producer_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`consumer_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_partnerships_producer_consumer_idx` ON `registry_partnerships` (`producer_org_id`,`consumer_org_id`);--> statement-breakpoint
CREATE TABLE `registry_provider_platforms` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`os` text NOT NULL,
	`arch` text NOT NULL,
	`filename` text NOT NULL,
	`download_url` text NOT NULL,
	`shasum` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `registry_provider_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_provider_platforms_ver_os_arch_idx` ON `registry_provider_platforms` (`version_id`,`os`,`arch`);--> statement-breakpoint
CREATE TABLE `registry_provider_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`version` text NOT NULL,
	`protocols` text DEFAULT '["5.0"]',
	`key_id` text,
	`shasums_url` text,
	`shasums_signature_url` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `registry_providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_provider_versions_prov_ver_idx` ON `registry_provider_versions` (`provider_id`,`version`);--> statement-breakpoint
CREATE TABLE `registry_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`namespace` text NOT NULL,
	`type` text NOT NULL,
	`registry_name` text DEFAULT 'private' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_providers_ns_type_idx` ON `registry_providers` (`namespace`,`type`);--> statement-breakpoint
CREATE TABLE `remote_state_consumers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`consumer_workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`consumer_workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_state_consumers_ws_consumer_idx` ON `remote_state_consumers` (`workspace_id`,`consumer_workspace_id`);--> statement-breakpoint
CREATE TABLE `reserved_tag_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`key` text NOT NULL,
	`disable_overrides` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reserved_tag_keys_org_key_idx` ON `reserved_tag_keys` (`org_id`,`key`);--> statement-breakpoint
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
CREATE TABLE `run_task_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`run_task_id` text NOT NULL,
	`task_stage_id` text,
	`status` text DEFAULT 'passed' NOT NULL,
	`message` text,
	`url` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_task_id`) REFERENCES `run_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_stage_id`) REFERENCES `task_stages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `run_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`url` text NOT NULL,
	`category` text DEFAULT 'general',
	`enabled` integer DEFAULT true,
	`hmac_key` text,
	`global_configuration` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `run_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source_workspace_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_triggers_ws_src_idx` ON `run_triggers` (`workspace_id`,`source_workspace_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`configuration_version_id` text,
	`agent_pool_id` text,
	`agent_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`message` text,
	`is_destroy` integer DEFAULT false,
	`auto_apply` integer DEFAULT false NOT NULL,
	`plan_only` integer DEFAULT false NOT NULL,
	`refresh` integer DEFAULT true NOT NULL,
	`refresh_only` integer DEFAULT false NOT NULL,
	`target_addrs` text,
	`replace_addrs` text,
	`variables` text,
	`log_token` text,
	`terraform_version` text,
	`debugging_mode` integer DEFAULT false NOT NULL,
	`allow_empty_apply` integer DEFAULT false NOT NULL,
	`save_plan` integer DEFAULT false NOT NULL,
	`allow_config_generation` integer DEFAULT false NOT NULL,
	`status_timestamps` text,
	`plan_resource_additions` integer,
	`plan_resource_changes` integer,
	`plan_resource_destructions` integer,
	`plan_resource_imports` integer,
	`apply_resource_additions` integer,
	`apply_resource_changes` integer,
	`apply_resource_destructions` integer,
	`apply_resource_imports` integer,
	`created_by` text,
	`applied_at` integer,
	`soft_deleted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`configuration_version_id`) REFERENCES `configuration_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `saml_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`debug` integer DEFAULT false NOT NULL,
	`old_idp_cert` text,
	`idp_cert` text,
	`idp_entity_id` text,
	`slo_endpoint_url` text,
	`sso_endpoint_url` text,
	`attr_username` text DEFAULT 'Username' NOT NULL,
	`attr_email` text DEFAULT 'email' NOT NULL,
	`attr_groups` text DEFAULT 'MemberOf' NOT NULL,
	`attr_site_admin` text DEFAULT 'SiteAdmin' NOT NULL,
	`site_admin_role` text DEFAULT 'site-admins' NOT NULL,
	`sso_api_token_session_timeout` integer DEFAULT 1209600 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scim_group_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`scim_user_id` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `scim_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scim_user_id`) REFERENCES `scim_user_identities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_group_memberships_group_user_idx` ON `scim_group_memberships` (`group_id`,`scim_user_id`);--> statement-breakpoint
CREATE TABLE `scim_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`external_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_groups_name_idx` ON `scim_groups` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_groups_external_id_idx` ON `scim_groups` (`external_id`);--> statement-breakpoint
CREATE TABLE `scim_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`site_admin_group_scim_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_admin_group_scim_id`) REFERENCES `scim_groups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `scim_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_tokens_token_hash_unique` ON `scim_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `scim_user_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`username` text NOT NULL,
	`external_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_user_identities_user_idx` ON `scim_user_identities` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_user_identities_username_idx` ON `scim_user_identities` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_user_identities_external_id_idx` ON `scim_user_identities` (`external_id`);--> statement-breakpoint
CREATE TABLE `site_data_retention_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`state_versions_count` integer,
	`delete_older_than_n_days` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ssh_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ssh_keys_org_name_idx` ON `ssh_keys` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `sso_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sso_challenges_kind_expires_idx` ON `sso_challenges` (`kind`,`expires_at`);--> statement-breakpoint
CREATE INDEX `sso_challenges_expires_idx` ON `sso_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `stack_variable_sets` (
	`stack_id` text NOT NULL,
	`variable_set_id` text NOT NULL,
	PRIMARY KEY(`stack_id`, `variable_set_id`),
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variable_set_id`) REFERENCES `variable_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `stacks` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text,
	`agent_pool_id` text,
	`name` text NOT NULL,
	`description` text,
	`speculative_enabled` integer DEFAULT false NOT NULL,
	`working_directory` text,
	`trigger_patterns` text DEFAULT '[]' NOT NULL,
	`vcs_identifier` text,
	`vcs_branch` text,
	`vcs_oauth_token_id` text,
	`vcs_gha_installation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `state_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`serial` integer NOT NULL,
	`state_payload` text,
	`status` text DEFAULT 'finalized',
	`json_state` text,
	`json_state_outputs` text,
	`vcs_commit_sha` text,
	`vcs_commit_url` text,
	`run_id` text,
	`terraform_version` text,
	`intermediate` integer DEFAULT false NOT NULL,
	`soft_deleted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `state_versions_ws_serial_idx` ON `state_versions` (`workspace_id`,`serial`);--> statement-breakpoint
CREATE TABLE `support_bundle_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`download_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_stages` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`stage` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`status_timestamps` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `team_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`sso_source` text,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_memberships_team_user_idx` ON `team_memberships` (`team_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `team_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`project_id` text NOT NULL,
	`access` text DEFAULT 'read' NOT NULL,
	`project_access` text,
	`workspace_access` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_projects_team_project_idx` ON `team_projects` (`team_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `team_scim_group_mappings` (
	`team_id` text PRIMARY KEY NOT NULL,
	`scim_group_id` text NOT NULL,
	`sync_paused` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scim_group_id`) REFERENCES `scim_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_scim_group_mappings_group_idx` ON `team_scim_group_mappings` (`scim_group_id`);--> statement-breakpoint
CREATE TABLE `team_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`access` text DEFAULT 'write' NOT NULL,
	`permissions` text,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_workspaces_team_workspace_idx` ON `team_workspaces` (`team_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`visibility` text DEFAULT 'organization' NOT NULL,
	`sso_team_id` text,
	`organization_access` text DEFAULT '{}' NOT NULL,
	`allow_member_token_management` integer DEFAULT false,
	`policy_override_delegation_expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_org_name_idx` ON `teams` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `test_variables` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`sensitive` integer DEFAULT false NOT NULL,
	`hcl` integer DEFAULT false NOT NULL,
	`category` text DEFAULT 'terraform' NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `registry_modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_variables_module_key_idx` ON `test_variables` (`module_id`,`key`);--> statement-breakpoint
CREATE TABLE `user_2fa` (
	`user_id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`email` text,
	`password_hash` text NOT NULL,
	`is_site_admin` integer DEFAULT false,
	`is_site_auditor` integer DEFAULT false,
	`is_suspended` integer DEFAULT false,
	`must_change_password` integer DEFAULT false NOT NULL,
	`theme` text DEFAULT 'original-light' NOT NULL,
	`sso_provider` text,
	`sso_subject` text,
	`sso_site_admin` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_sso_identity_idx` ON `users` (`sso_provider`,`sso_subject`);--> statement-breakpoint
CREATE TABLE `variable_set_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`variable_set_id` text NOT NULL,
	`project_id` text NOT NULL,
	FOREIGN KEY (`variable_set_id`) REFERENCES `variable_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variable_set_projects_idx` ON `variable_set_projects` (`variable_set_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `variable_set_variables` (
	`id` text PRIMARY KEY NOT NULL,
	`variable_set_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`sensitive` integer DEFAULT false,
	`category` text DEFAULT 'terraform' NOT NULL,
	`description` text,
	FOREIGN KEY (`variable_set_id`) REFERENCES `variable_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variable_set_variables_idx` ON `variable_set_variables` (`variable_set_id`,`key`);--> statement-breakpoint
CREATE TABLE `variable_set_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`variable_set_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`variable_set_id`) REFERENCES `variable_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variable_set_workspaces_idx` ON `variable_set_workspaces` (`variable_set_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `variable_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`parent_project_id` text,
	`name` text NOT NULL,
	`description` text,
	`global` integer DEFAULT false,
	`priority` integer DEFAULT false,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
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
CREATE UNIQUE INDEX `workspace_run_tasks_idx` ON `workspace_run_tasks` (`workspace_id`,`run_task_id`);--> statement-breakpoint
CREATE TABLE `workspace_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_tags_workspace_key_idx` ON `workspace_tags` (`workspace_id`,`key`);--> statement-breakpoint
CREATE TABLE `workspace_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`source_workspace_id` text,
	`destination_org_id` text,
	`destination_project_id` text,
	`approval_mode` text DEFAULT 'auto' NOT NULL,
	`cleanup_on_failure` integer DEFAULT true,
	`history_cutoff` text,
	`policy_set_mode` text DEFAULT 'move' NOT NULL,
	`variable_mode` text DEFAULT 'move' NOT NULL,
	`workspace_prefix` text,
	`workspace_suffix` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`pause_reason` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`destination_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`destination_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `workspace_variables` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`sensitive` integer DEFAULT false,
	`hcl` integer DEFAULT false,
	`category` text DEFAULT 'terraform' NOT NULL,
	`description` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`org_id` text NOT NULL,
	`project_id` text,
	`ssh_key_id` text,
	`iac_binary` text,
	`terraform_version` text DEFAULT 'latest',
	`working_directory` text,
	`source_name` text,
	`source_url` text,
	`source` text DEFAULT 'tfe-api',
	`auto_apply` integer DEFAULT false,
	`auto_apply_run_trigger` integer DEFAULT false,
	`file_triggers_enabled` integer DEFAULT true,
	`trigger_prefixes` text,
	`trigger_patterns` text,
	`vcs_repo` text,
	`queue_all_runs` integer DEFAULT true,
	`speculative_enabled` integer DEFAULT true,
	`allow_destroy_plan` integer DEFAULT true,
	`global_remote_state` integer DEFAULT false,
	`project_remote_state` integer DEFAULT false,
	`execution_mode` text DEFAULT 'remote' NOT NULL,
	`agent_pool_id` text,
	`assessments_enabled` integer DEFAULT false,
	`auto_destroy_at` text,
	`auto_destroy_activity_duration` text,
	`inherits_project_auto_destroy` integer DEFAULT false NOT NULL,
	`setting_overwrites` text,
	`locked` integer DEFAULT false,
	`locked_reason` text,
	`owned_by_type` text,
	`owned_by_id` text,
	`contact_email` text,
	`updated_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`ssh_key_id`) REFERENCES `ssh_keys`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE set null
);
