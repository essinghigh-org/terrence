CREATE TABLE "admin_general_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"limit_user_organization_creation" boolean DEFAULT true NOT NULL,
	"api_rate_limiting_enabled" boolean DEFAULT true NOT NULL,
	"api_rate_limit" bigint DEFAULT 30 NOT NULL,
	"plan_timeout" text DEFAULT '2h' NOT NULL,
	"apply_timeout" text DEFAULT '24h' NOT NULL,
	"send_passing_statuses" boolean DEFAULT false NOT NULL,
	"allow_speculative_plans_forks" boolean DEFAULT false NOT NULL,
	"default_remote_state_access" boolean DEFAULT true NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_opa_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"url" text,
	"sha" text,
	"deprecated" boolean DEFAULT false,
	"enabled" boolean DEFAULT true,
	"is_default" boolean DEFAULT false,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_sentinel_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"url" text,
	"sha" text,
	"deprecated" boolean DEFAULT false,
	"enabled" boolean DEFAULT true,
	"is_default" boolean DEFAULT false,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"values" jsonb NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_terraform_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"url" text,
	"sha" text,
	"deprecated" boolean DEFAULT false,
	"enabled" boolean DEFAULT true,
	"is_default" boolean DEFAULT false,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"agent_pool_id" text NOT NULL,
	"agent_id" text,
	"phase" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"error_message" text,
	"claimed_at" bigint,
	"completed_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_pool_allowed_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_pool_id" text NOT NULL,
	"project_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_pool_allowed_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_pool_id" text NOT NULL,
	"workspace_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_pool_excluded_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_pool_id" text NOT NULL,
	"workspace_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_pool_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_pool_id" text NOT NULL,
	"token" text NOT NULL,
	"description" text,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint
);
--> statement-breakpoint
CREATE TABLE "agent_pools" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"organization_scoped" boolean DEFAULT true,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_pool_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"ip_address" text,
	"version" text,
	"architecture" text,
	"last_ping_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text,
	"org_id" text,
	"team_id" text,
	"description" text,
	"scopes" text,
	"token_type" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	"expires_at" bigint
);
--> statement-breakpoint
CREATE TABLE "check_results" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"assessment_result_id" text,
	"run_id" text,
	"address" text NOT NULL,
	"kind" text DEFAULT 'check' NOT NULL,
	"status" text NOT NULL,
	"message" text,
	"detail" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assessment_results" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"succeeded" boolean,
	"drifted" boolean,
	"error_message" text,
	"resources_drifted" bigint DEFAULT 0 NOT NULL,
	"resources_undrifted" bigint DEFAULT 0 NOT NULL,
	"all_checks_succeeded" boolean,
	"checks_passed" bigint DEFAULT 0 NOT NULL,
	"checks_failed" bigint DEFAULT 0 NOT NULL,
	"checks_errored" bigint DEFAULT 0 NOT NULL,
	"checks_unknown" bigint DEFAULT 0 NOT NULL,
	"json_output" jsonb,
	"json_schema" jsonb,
	"log_output" text,
	"created_at" bigint NOT NULL,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"user_id" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"details" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" text,
	"resolved_by" text,
	"resolved_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cidr_range_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enforcement_scope" text DEFAULT 'organization' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cidr_ranges" (
	"id" text PRIMARY KEY NOT NULL,
	"cidr_range_list_id" text NOT NULL,
	"value" text NOT NULL,
	"description" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "configuration_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"auto_queue_runs" boolean DEFAULT true NOT NULL,
	"archive_path" text,
	"speculative" boolean DEFAULT false NOT NULL,
	"provisional" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'tfe-api',
	"ingress_attributes" jsonb,
	"status_timestamps" jsonb,
	"error" text,
	"error_message" text,
	"soft_deleted_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_retention_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"state_versions_count" bigint,
	"delete_older_than_n_days" bigint,
	"auto_destroy_at" text,
	"auto_destroy_activity_duration" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_app_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"icon_url" text,
	"installation_type" text DEFAULT 'Organization',
	"installation_url" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"received_at" bigint NOT NULL,
	"processed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "hyok_configurations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"kek_id" text NOT NULL,
	"kms_options" jsonb,
	"agent_pool_id" text,
	"oidc_config_id" text NOT NULL,
	"oidc_config_type" text NOT NULL,
	"is_primary" boolean DEFAULT false,
	"status" text DEFAULT 'ok' NOT NULL,
	"error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hyok_customer_key_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"hyok_config_id" text NOT NULL,
	"key_version" text NOT NULL,
	"encrypted_dek" text NOT NULL,
	"customer_key_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"workspaces_secured" bigint DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "logs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"phase" text NOT NULL,
	"output_text" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "module_test_configurations" (
	"id" text PRIMARY KEY NOT NULL,
	"module_id" text NOT NULL,
	"oidc_provider_url" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "module_test_results" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"output" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "no_code_modules" (
	"id" text PRIMARY KEY NOT NULL,
	"module_id" text NOT NULL,
	"version_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "no_code_variable_options" (
	"id" text PRIMARY KEY NOT NULL,
	"no_code_module_id" text NOT NULL,
	"variable_name" text NOT NULL,
	"variable_type" text NOT NULL,
	"options" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "no_code_workspace_configurations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"no_code_module_id" text,
	"module_id" text,
	"module_version_id" text,
	"configuration_version_id" text,
	"module_source" text NOT NULL,
	"module_version" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_configurations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"team_id" text,
	"project_id" text,
	"name" text NOT NULL,
	"destination_type" text NOT NULL,
	"url" text NOT NULL,
	"triggers" jsonb NOT NULL,
	"enabled" boolean DEFAULT true,
	"token" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"oauth_client_id" text NOT NULL,
	"project_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"agent_pool_id" text,
	"name" text NOT NULL,
	"service_provider" text DEFAULT 'github' NOT NULL,
	"api_url" text,
	"http_url" text,
	"key" text,
	"secret" text,
	"rsa_public_key" text,
	"organization_scoped" boolean DEFAULT false,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_device_codes" (
	"device_code" text PRIMARY KEY NOT NULL,
	"user_code" text NOT NULL,
	"user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"token" text,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"oauth_client_id" text NOT NULL,
	"service_provider_user" text,
	"token" text NOT NULL,
	"has_ssh_key" boolean DEFAULT false,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"config_type" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_token_ttl_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"token_type" text NOT NULL,
	"max_ttl_ms" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_data_retention_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"state_versions_count" bigint,
	"delete_older_than_n_days" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_membership_roles" (
	"membership_id" text NOT NULL,
	"role_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"sso_source" text
);
--> statement-breakpoint
CREATE TABLE "organization_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"default_iac_binary" text DEFAULT 'tofu',
	"default_terraform_version" text DEFAULT 'latest',
	"assessments_enforced" boolean DEFAULT false NOT NULL,
	"global_module_sharing" boolean DEFAULT false NOT NULL,
	"global_provider_sharing" boolean DEFAULT false NOT NULL,
	"access_beta_tools" boolean DEFAULT false NOT NULL,
	"workspace_limit" bigint,
	"saml_enabled" boolean DEFAULT false NOT NULL,
	"owners_team_saml_role_id" text,
	"allow_force_delete_workspaces" boolean DEFAULT true NOT NULL,
	"stacks_enabled" boolean DEFAULT false NOT NULL,
	"show_pre_releases" boolean DEFAULT false NOT NULL,
	"default_execution_mode" text DEFAULT 'remote',
	"aggregated_commit_status_enabled" boolean DEFAULT true NOT NULL,
	"send_passing_statuses" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"data_type" text DEFAULT 'sentinel-mock-bundle-v0' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"download_url" text,
	"expires_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"policy_set_id" text,
	"policy_set_version_id" text,
	"name" text NOT NULL,
	"description" text,
	"enforcement_level" text DEFAULT 'soft-mandatory' NOT NULL,
	"query" text,
	"source" text,
	"source_path" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"policy_id" text,
	"policy_set_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"task_stage_id" text,
	"run_id" text,
	"status" text DEFAULT 'passed' NOT NULL,
	"policy_kind" text DEFAULT 'opa',
	"policy_tool_version" text DEFAULT '0.44.0',
	"result_count" jsonb,
	"status_timestamps" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_set_exclusions" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_set_id" text NOT NULL,
	"workspace_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_set_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_evaluation_id" text NOT NULL,
	"policy_set_name" text,
	"policy_name" text,
	"enforcement_level" text DEFAULT 'advisory' NOT NULL,
	"status" text DEFAULT 'passed' NOT NULL,
	"query" text,
	"description" text,
	"error" text,
	"overridable" boolean DEFAULT false,
	"result_count" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_set_parameters" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_set_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"sensitive" boolean DEFAULT false,
	"hcl" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "policy_set_project_exclusions" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_set_id" text NOT NULL,
	"project_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_set_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_set_id" text NOT NULL,
	"project_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_set_tag_selectors" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_set_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text,
	"is_exclude" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_set_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_set_id" text NOT NULL,
	"source" text DEFAULT 'tfe-api' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_timestamps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ingress_attributes" jsonb,
	"error" text,
	"archive_path" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_set_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_set_id" text NOT NULL,
	"workspace_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'sentinel' NOT NULL,
	"global" boolean DEFAULT false,
	"overridable" boolean DEFAULT true,
	"agent_enabled" boolean DEFAULT false,
	"policy_tool_version" text,
	"policies_path" text,
	"vcs_repo" jsonb,
	"policy_update_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_execution_mode" text DEFAULT 'remote',
	"auto_destroy_activity_duration" text,
	"setting_overwrites" jsonb,
	"default_agent_pool_id" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"provider_source" text NOT NULL,
	"configuration_hcl" text,
	"global" boolean DEFAULT false,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "query_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source" text DEFAULT 'tfe-api' NOT NULL,
	"variables" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"log_read_url" text,
	"status_timestamps" jsonb,
	"created_by" text,
	"canceled_by" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token_id" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"rotated_at" bigint,
	"revoked_at" bigint,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_gpg_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"namespace" text NOT NULL,
	"key_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"ascii_armor" text NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"source_url" text,
	"trust_signature" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_module_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"module_id" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"archive_path" text,
	"key_id" text,
	"is_deprecated" boolean DEFAULT false,
	"is_revoked" boolean DEFAULT false,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_modules" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"namespace" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_partnerships" (
	"id" text PRIMARY KEY NOT NULL,
	"producer_org_id" text NOT NULL,
	"consumer_org_id" text NOT NULL,
	"modules" boolean DEFAULT false NOT NULL,
	"providers" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_provider_platforms" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"os" text NOT NULL,
	"arch" text NOT NULL,
	"filename" text NOT NULL,
	"download_url" text NOT NULL,
	"shasum" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_provider_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"version" text NOT NULL,
	"protocols" jsonb DEFAULT '["5.0"]'::jsonb,
	"key_id" text,
	"shasums_url" text,
	"shasums_signature_url" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"namespace" text NOT NULL,
	"type" text NOT NULL,
	"registry_name" text DEFAULT 'private' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remote_state_consumers" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"consumer_workspace_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reserved_tag_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"key" text NOT NULL,
	"disable_overrides" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text,
	"body" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_explanations" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"content" text NOT NULL,
	"thinking" text,
	"input_hash" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_task_results" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"run_task_id" text NOT NULL,
	"task_stage_id" text,
	"status" text DEFAULT 'passed' NOT NULL,
	"message" text,
	"url" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"url" text NOT NULL,
	"category" text DEFAULT 'general',
	"enabled" boolean DEFAULT true,
	"hmac_key" text,
	"global_configuration" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_workspace_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"configuration_version_id" text,
	"agent_pool_id" text,
	"agent_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" text,
	"is_destroy" boolean DEFAULT false,
	"auto_apply" boolean DEFAULT false NOT NULL,
	"plan_only" boolean DEFAULT false NOT NULL,
	"refresh" boolean DEFAULT true NOT NULL,
	"refresh_only" boolean DEFAULT false NOT NULL,
	"target_addrs" jsonb,
	"replace_addrs" jsonb,
	"variables" jsonb,
	"log_token" text,
	"terraform_version" text,
	"debugging_mode" boolean DEFAULT false NOT NULL,
	"allow_empty_apply" boolean DEFAULT false NOT NULL,
	"save_plan" boolean DEFAULT false NOT NULL,
	"allow_config_generation" boolean DEFAULT false NOT NULL,
	"status_timestamps" jsonb,
	"plan_resource_additions" bigint,
	"plan_resource_changes" bigint,
	"plan_resource_destructions" bigint,
	"plan_resource_imports" bigint,
	"apply_resource_additions" bigint,
	"apply_resource_changes" bigint,
	"apply_resource_destructions" bigint,
	"apply_resource_imports" bigint,
	"created_by" text,
	"applied_at" bigint,
	"scheduled_at" bigint,
	"soft_deleted_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saml_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"debug" boolean DEFAULT false NOT NULL,
	"old_idp_cert" text,
	"idp_cert" text,
	"idp_entity_id" text,
	"slo_endpoint_url" text,
	"sso_endpoint_url" text,
	"attr_username" text DEFAULT 'Username' NOT NULL,
	"attr_email" text DEFAULT 'email' NOT NULL,
	"attr_groups" text DEFAULT 'MemberOf' NOT NULL,
	"attr_site_admin" text DEFAULT 'SiteAdmin' NOT NULL,
	"site_admin_role" text DEFAULT 'site-admins' NOT NULL,
	"sso_api_token_session_timeout" bigint DEFAULT 1209600 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_group_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"scim_user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"external_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"site_admin_group_scim_id" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"description" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"last_used_at" bigint
);
--> statement-breakpoint
CREATE TABLE "scim_user_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"username" text NOT NULL,
	"external_id" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_data_retention_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"state_versions_count" bigint,
	"delete_older_than_n_days" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssh_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stack_variable_sets" (
	"stack_id" text NOT NULL,
	"variable_set_id" text NOT NULL,
	CONSTRAINT "stack_variable_sets_stack_id_variable_set_id_pk" PRIMARY KEY("stack_id","variable_set_id")
);
--> statement-breakpoint
CREATE TABLE "stacks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"agent_pool_id" text,
	"name" text NOT NULL,
	"description" text,
	"speculative_enabled" boolean DEFAULT false NOT NULL,
	"working_directory" text,
	"trigger_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vcs_identifier" text,
	"vcs_branch" text,
	"vcs_oauth_token_id" text,
	"vcs_gha_installation_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "state_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"serial" bigint NOT NULL,
	"state_payload" text,
	"status" text DEFAULT 'finalized',
	"json_state" text,
	"json_state_outputs" text,
	"vcs_commit_sha" text,
	"vcs_commit_url" text,
	"run_id" text,
	"terraform_version" text,
	"intermediate" boolean DEFAULT false NOT NULL,
	"soft_deleted_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_bundle_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"download_url" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_stages" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"stage" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_timestamps" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"sso_source" text
);
--> statement-breakpoint
CREATE TABLE "team_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"access" text DEFAULT 'read' NOT NULL,
	"project_access" jsonb,
	"workspace_access" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_scim_group_mappings" (
	"team_id" text PRIMARY KEY NOT NULL,
	"scim_group_id" text NOT NULL,
	"sync_paused" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"access" text DEFAULT 'write' NOT NULL,
	"permissions" jsonb
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"visibility" text DEFAULT 'organization' NOT NULL,
	"sso_team_id" text,
	"organization_access" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allow_member_token_management" boolean DEFAULT false,
	"policy_override_delegation_expires_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_variables" (
	"id" text PRIMARY KEY NOT NULL,
	"module_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"hcl" boolean DEFAULT false NOT NULL,
	"category" text DEFAULT 'terraform' NOT NULL,
	"description" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_2fa" (
	"user_id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"email" text,
	"password_hash" text NOT NULL,
	"is_site_admin" boolean DEFAULT false,
	"is_site_auditor" boolean DEFAULT false,
	"is_suspended" boolean DEFAULT false,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"theme" text DEFAULT 'original-light' NOT NULL,
	"sso_provider" text,
	"sso_subject" text,
	"sso_site_admin" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variable_set_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"variable_set_id" text NOT NULL,
	"project_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variable_set_variables" (
	"id" text PRIMARY KEY NOT NULL,
	"variable_set_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"sensitive" boolean DEFAULT false,
	"category" text DEFAULT 'terraform' NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "variable_set_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"variable_set_id" text NOT NULL,
	"workspace_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variable_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"parent_project_id" text,
	"name" text NOT NULL,
	"description" text,
	"global" boolean DEFAULT false,
	"priority" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "workspace_run_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_task_id" text NOT NULL,
	"stage" text DEFAULT 'post_plan' NOT NULL,
	"enforcement_level" text DEFAULT 'advisory' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text
);
--> statement-breakpoint
CREATE TABLE "workspace_transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"source_workspace_id" text,
	"destination_org_id" text,
	"destination_project_id" text,
	"approval_mode" text DEFAULT 'auto' NOT NULL,
	"cleanup_on_failure" boolean DEFAULT true,
	"history_cutoff" text,
	"policy_set_mode" text DEFAULT 'move' NOT NULL,
	"variable_mode" text DEFAULT 'move' NOT NULL,
	"workspace_prefix" text,
	"workspace_suffix" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"pause_reason" text,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_variables" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"sensitive" boolean DEFAULT false,
	"hcl" boolean DEFAULT false,
	"category" text DEFAULT 'terraform' NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"org_id" text NOT NULL,
	"project_id" text,
	"ssh_key_id" text,
	"iac_binary" text,
	"terraform_version" text DEFAULT 'latest',
	"working_directory" text,
	"source_name" text,
	"source_url" text,
	"source" text DEFAULT 'tfe-api',
	"auto_apply" boolean DEFAULT false,
	"auto_apply_run_trigger" boolean DEFAULT false,
	"file_triggers_enabled" boolean DEFAULT true,
	"trigger_prefixes" jsonb,
	"trigger_patterns" jsonb,
	"vcs_repo" jsonb,
	"queue_all_runs" boolean DEFAULT true,
	"speculative_enabled" boolean DEFAULT true,
	"allow_destroy_plan" boolean DEFAULT true,
	"global_remote_state" boolean DEFAULT false,
	"project_remote_state" boolean DEFAULT false,
	"execution_mode" text DEFAULT 'remote' NOT NULL,
	"agent_pool_id" text,
	"assessments_enabled" boolean DEFAULT false,
	"auto_destroy_at" text,
	"auto_destroy_activity_duration" text,
	"inherits_project_auto_destroy" boolean DEFAULT false NOT NULL,
	"setting_overwrites" jsonb,
	"locked" boolean DEFAULT false,
	"locked_reason" text,
	"owned_by_type" text,
	"owned_by_id" text,
	"contact_email" text,
	"updated_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_agent_pool_id_agent_pools_id_fk" FOREIGN KEY ("agent_pool_id") REFERENCES "public"."agent_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pool_allowed_projects" ADD CONSTRAINT "agent_pool_allowed_projects_agent_pool_id_agent_pools_id_fk" FOREIGN KEY ("agent_pool_id") REFERENCES "public"."agent_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pool_allowed_projects" ADD CONSTRAINT "agent_pool_allowed_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pool_allowed_workspaces" ADD CONSTRAINT "agent_pool_allowed_workspaces_agent_pool_id_agent_pools_id_fk" FOREIGN KEY ("agent_pool_id") REFERENCES "public"."agent_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pool_allowed_workspaces" ADD CONSTRAINT "agent_pool_allowed_workspaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pool_excluded_workspaces" ADD CONSTRAINT "agent_pool_excluded_workspaces_agent_pool_id_agent_pools_id_fk" FOREIGN KEY ("agent_pool_id") REFERENCES "public"."agent_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pool_excluded_workspaces" ADD CONSTRAINT "agent_pool_excluded_workspaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pool_tokens" ADD CONSTRAINT "agent_pool_tokens_agent_pool_id_agent_pools_id_fk" FOREIGN KEY ("agent_pool_id") REFERENCES "public"."agent_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pools" ADD CONSTRAINT "agent_pools_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_agent_pool_id_agent_pools_id_fk" FOREIGN KEY ("agent_pool_id") REFERENCES "public"."agent_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_results" ADD CONSTRAINT "check_results_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_results" ADD CONSTRAINT "check_results_assessment_result_id_assessment_results_id_fk" FOREIGN KEY ("assessment_result_id") REFERENCES "public"."assessment_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_results" ADD CONSTRAINT "check_results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_results" ADD CONSTRAINT "assessment_results_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cidr_range_lists" ADD CONSTRAINT "cidr_range_lists_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cidr_ranges" ADD CONSTRAINT "cidr_ranges_cidr_range_list_id_cidr_range_lists_id_fk" FOREIGN KEY ("cidr_range_list_id") REFERENCES "public"."cidr_range_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configuration_versions" ADD CONSTRAINT "configuration_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_retention_policies" ADD CONSTRAINT "data_retention_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_app_installations" ADD CONSTRAINT "github_app_installations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hyok_configurations" ADD CONSTRAINT "hyok_configurations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hyok_configurations" ADD CONSTRAINT "hyok_configurations_agent_pool_id_agent_pools_id_fk" FOREIGN KEY ("agent_pool_id") REFERENCES "public"."agent_pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hyok_customer_key_versions" ADD CONSTRAINT "hyok_customer_key_versions_hyok_config_id_hyok_configurations_id_fk" FOREIGN KEY ("hyok_config_id") REFERENCES "public"."hyok_configurations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_test_configurations" ADD CONSTRAINT "module_test_configurations_module_id_registry_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."registry_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_test_results" ADD CONSTRAINT "module_test_results_version_id_registry_module_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."registry_module_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_code_modules" ADD CONSTRAINT "no_code_modules_module_id_registry_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."registry_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_code_modules" ADD CONSTRAINT "no_code_modules_version_id_registry_module_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."registry_module_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_code_variable_options" ADD CONSTRAINT "no_code_variable_options_no_code_module_id_no_code_modules_id_fk" FOREIGN KEY ("no_code_module_id") REFERENCES "public"."no_code_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_code_workspace_configurations" ADD CONSTRAINT "no_code_workspace_configurations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_code_workspace_configurations" ADD CONSTRAINT "no_code_workspace_configurations_no_code_module_id_no_code_modules_id_fk" FOREIGN KEY ("no_code_module_id") REFERENCES "public"."no_code_modules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_code_workspace_configurations" ADD CONSTRAINT "no_code_workspace_configurations_module_id_registry_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."registry_modules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_code_workspace_configurations" ADD CONSTRAINT "no_code_workspace_configurations_module_version_id_registry_module_versions_id_fk" FOREIGN KEY ("module_version_id") REFERENCES "public"."registry_module_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_code_workspace_configurations" ADD CONSTRAINT "no_code_workspace_configurations_configuration_version_id_configuration_versions_id_fk" FOREIGN KEY ("configuration_version_id") REFERENCES "public"."configuration_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_configurations" ADD CONSTRAINT "notification_configurations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_configurations" ADD CONSTRAINT "notification_configurations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_configurations" ADD CONSTRAINT "notification_configurations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_projects" ADD CONSTRAINT "oauth_client_projects_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_projects" ADD CONSTRAINT "oauth_client_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_agent_pool_id_agent_pools_id_fk" FOREIGN KEY ("agent_pool_id") REFERENCES "public"."agent_pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_device_codes" ADD CONSTRAINT "oauth_device_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_configs" ADD CONSTRAINT "oidc_configs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_token_ttl_policies" ADD CONSTRAINT "org_token_ttl_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_data_retention_policies" ADD CONSTRAINT "organization_data_retention_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_membership_roles" ADD CONSTRAINT "organization_membership_roles_membership_id_organization_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."organization_memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_membership_roles" ADD CONSTRAINT "organization_membership_roles_role_id_organization_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."organization_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_roles" ADD CONSTRAINT "organization_roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_policy_set_id_policy_sets_id_fk" FOREIGN KEY ("policy_set_id") REFERENCES "public"."policy_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_policy_set_version_id_policy_set_versions_id_fk" FOREIGN KEY ("policy_set_version_id") REFERENCES "public"."policy_set_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_checks" ADD CONSTRAINT "policy_checks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_checks" ADD CONSTRAINT "policy_checks_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_checks" ADD CONSTRAINT "policy_checks_policy_set_id_policy_sets_id_fk" FOREIGN KEY ("policy_set_id") REFERENCES "public"."policy_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_evaluations" ADD CONSTRAINT "policy_evaluations_task_stage_id_task_stages_id_fk" FOREIGN KEY ("task_stage_id") REFERENCES "public"."task_stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_evaluations" ADD CONSTRAINT "policy_evaluations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_set_exclusions" ADD CONSTRAINT "policy_set_exclusions_policy_set_id_policy_sets_id_fk" FOREIGN KEY ("policy_set_id") REFERENCES "public"."policy_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_set_exclusions" ADD CONSTRAINT "policy_set_exclusions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_set_outcomes" ADD CONSTRAINT "policy_set_outcomes_policy_evaluation_id_policy_evaluations_id_fk" FOREIGN KEY ("policy_evaluation_id") REFERENCES "public"."policy_evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_set_parameters" ADD CONSTRAINT "policy_set_parameters_policy_set_id_policy_sets_id_fk" FOREIGN KEY ("policy_set_id") REFERENCES "public"."policy_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_set_project_exclusions" ADD CONSTRAINT "policy_set_project_exclusions_policy_set_id_policy_sets_id_fk" FOREIGN KEY ("policy_set_id") REFERENCES "public"."policy_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_set_project_exclusions" ADD CONSTRAINT "policy_set_project_exclusions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_set_projects" ADD CONSTRAINT "policy_set_projects_policy_set_id_policy_sets_id_fk" FOREIGN KEY ("policy_set_id") REFERENCES "public"."policy_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_set_projects" ADD CONSTRAINT "policy_set_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_set_tag_selectors" ADD CONSTRAINT "policy_set_tag_selectors_policy_set_id_policy_sets_id_fk" FOREIGN KEY ("policy_set_id") REFERENCES "public"."policy_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_set_versions" ADD CONSTRAINT "policy_set_versions_policy_set_id_policy_sets_id_fk" FOREIGN KEY ("policy_set_id") REFERENCES "public"."policy_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_set_workspaces" ADD CONSTRAINT "policy_set_workspaces_policy_set_id_policy_sets_id_fk" FOREIGN KEY ("policy_set_id") REFERENCES "public"."policy_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_set_workspaces" ADD CONSTRAINT "policy_set_workspaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_sets" ADD CONSTRAINT "policy_sets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tags" ADD CONSTRAINT "project_tags_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_agent_pool_id_agent_pools_id_fk" FOREIGN KEY ("default_agent_pool_id") REFERENCES "public"."agent_pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_sets" ADD CONSTRAINT "provider_sets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_runs" ADD CONSTRAINT "query_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_runs" ADD CONSTRAINT "query_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_runs" ADD CONSTRAINT "query_runs_canceled_by_users_id_fk" FOREIGN KEY ("canceled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_gpg_keys" ADD CONSTRAINT "registry_gpg_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_module_versions" ADD CONSTRAINT "registry_module_versions_module_id_registry_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."registry_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD CONSTRAINT "registry_modules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_partnerships" ADD CONSTRAINT "registry_partnerships_producer_org_id_organizations_id_fk" FOREIGN KEY ("producer_org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_partnerships" ADD CONSTRAINT "registry_partnerships_consumer_org_id_organizations_id_fk" FOREIGN KEY ("consumer_org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_provider_platforms" ADD CONSTRAINT "registry_provider_platforms_version_id_registry_provider_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."registry_provider_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_provider_versions" ADD CONSTRAINT "registry_provider_versions_provider_id_registry_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."registry_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_providers" ADD CONSTRAINT "registry_providers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_state_consumers" ADD CONSTRAINT "remote_state_consumers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_state_consumers" ADD CONSTRAINT "remote_state_consumers_consumer_workspace_id_workspaces_id_fk" FOREIGN KEY ("consumer_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reserved_tag_keys" ADD CONSTRAINT "reserved_tag_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_comments" ADD CONSTRAINT "run_comments_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_comments" ADD CONSTRAINT "run_comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_explanations" ADD CONSTRAINT "run_explanations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_task_results" ADD CONSTRAINT "run_task_results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_task_results" ADD CONSTRAINT "run_task_results_run_task_id_run_tasks_id_fk" FOREIGN KEY ("run_task_id") REFERENCES "public"."run_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_task_results" ADD CONSTRAINT "run_task_results_task_stage_id_task_stages_id_fk" FOREIGN KEY ("task_stage_id") REFERENCES "public"."task_stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tasks" ADD CONSTRAINT "run_tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_triggers" ADD CONSTRAINT "run_triggers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_triggers" ADD CONSTRAINT "run_triggers_source_workspace_id_workspaces_id_fk" FOREIGN KEY ("source_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_configuration_version_id_configuration_versions_id_fk" FOREIGN KEY ("configuration_version_id") REFERENCES "public"."configuration_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_pool_id_agent_pools_id_fk" FOREIGN KEY ("agent_pool_id") REFERENCES "public"."agent_pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_memberships" ADD CONSTRAINT "scim_group_memberships_group_id_scim_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_memberships" ADD CONSTRAINT "scim_group_memberships_scim_user_id_scim_user_identities_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "public"."scim_user_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_settings" ADD CONSTRAINT "scim_settings_site_admin_group_scim_id_scim_groups_id_fk" FOREIGN KEY ("site_admin_group_scim_id") REFERENCES "public"."scim_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_user_identities" ADD CONSTRAINT "scim_user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_keys" ADD CONSTRAINT "ssh_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_variable_sets" ADD CONSTRAINT "stack_variable_sets_stack_id_stacks_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."stacks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_variable_sets" ADD CONSTRAINT "stack_variable_sets_variable_set_id_variable_sets_id_fk" FOREIGN KEY ("variable_set_id") REFERENCES "public"."variable_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stacks" ADD CONSTRAINT "stacks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stacks" ADD CONSTRAINT "stacks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_versions" ADD CONSTRAINT "state_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_versions" ADD CONSTRAINT "state_versions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_stages" ADD CONSTRAINT "task_stages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_projects" ADD CONSTRAINT "team_projects_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_projects" ADD CONSTRAINT "team_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_scim_group_mappings" ADD CONSTRAINT "team_scim_group_mappings_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_scim_group_mappings" ADD CONSTRAINT "team_scim_group_mappings_scim_group_id_scim_groups_id_fk" FOREIGN KEY ("scim_group_id") REFERENCES "public"."scim_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_workspaces" ADD CONSTRAINT "team_workspaces_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_workspaces" ADD CONSTRAINT "team_workspaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_variables" ADD CONSTRAINT "test_variables_module_id_registry_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."registry_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_2fa" ADD CONSTRAINT "user_2fa_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable_set_projects" ADD CONSTRAINT "variable_set_projects_variable_set_id_variable_sets_id_fk" FOREIGN KEY ("variable_set_id") REFERENCES "public"."variable_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable_set_projects" ADD CONSTRAINT "variable_set_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable_set_variables" ADD CONSTRAINT "variable_set_variables_variable_set_id_variable_sets_id_fk" FOREIGN KEY ("variable_set_id") REFERENCES "public"."variable_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable_set_workspaces" ADD CONSTRAINT "variable_set_workspaces_variable_set_id_variable_sets_id_fk" FOREIGN KEY ("variable_set_id") REFERENCES "public"."variable_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable_set_workspaces" ADD CONSTRAINT "variable_set_workspaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable_sets" ADD CONSTRAINT "variable_sets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable_sets" ADD CONSTRAINT "variable_sets_parent_project_id_projects_id_fk" FOREIGN KEY ("parent_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_run_tasks" ADD CONSTRAINT "workspace_run_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_run_tasks" ADD CONSTRAINT "workspace_run_tasks_run_task_id_run_tasks_id_fk" FOREIGN KEY ("run_task_id") REFERENCES "public"."run_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_tags" ADD CONSTRAINT "workspace_tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_transfers" ADD CONSTRAINT "workspace_transfers_source_workspace_id_workspaces_id_fk" FOREIGN KEY ("source_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_transfers" ADD CONSTRAINT "workspace_transfers_destination_org_id_organizations_id_fk" FOREIGN KEY ("destination_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_transfers" ADD CONSTRAINT "workspace_transfers_destination_project_id_projects_id_fk" FOREIGN KEY ("destination_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_transfers" ADD CONSTRAINT "workspace_transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_variables" ADD CONSTRAINT "workspace_variables_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_ssh_key_id_ssh_keys_id_fk" FOREIGN KEY ("ssh_key_id") REFERENCES "public"."ssh_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_agent_pool_id_agent_pools_id_fk" FOREIGN KEY ("agent_pool_id") REFERENCES "public"."agent_pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_jobs_run_phase_idx" ON "agent_jobs" USING btree ("run_id","phase");--> statement-breakpoint
CREATE INDEX "agent_jobs_pool_status_created_idx" ON "agent_jobs" USING btree ("agent_pool_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_pool_allowed_projects_pool_project_idx" ON "agent_pool_allowed_projects" USING btree ("agent_pool_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_pool_allowed_workspaces_pool_workspace_idx" ON "agent_pool_allowed_workspaces" USING btree ("agent_pool_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_pool_excluded_workspaces_pool_workspace_idx" ON "agent_pool_excluded_workspaces" USING btree ("agent_pool_id","workspace_id");--> statement-breakpoint
CREATE INDEX "check_results_assessment_idx" ON "check_results" USING btree ("assessment_result_id");--> statement-breakpoint
CREATE INDEX "check_results_run_idx" ON "check_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "assessment_results_workspace_created_idx" ON "assessment_results" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "change_requests_workspace_created_idx" ON "change_requests" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "github_app_installations_org_installation_idx" ON "github_app_installations" USING btree ("org_id","installation_id");--> statement-breakpoint
CREATE INDEX "logs_run_phase_idx" ON "logs" USING btree ("run_id","phase");--> statement-breakpoint
CREATE UNIQUE INDEX "no_code_modules_module_idx" ON "no_code_modules" USING btree ("module_id");--> statement-breakpoint
CREATE UNIQUE INDEX "no_code_variable_options_module_name_idx" ON "no_code_variable_options" USING btree ("no_code_module_id","variable_name");--> statement-breakpoint
CREATE UNIQUE INDEX "no_code_workspace_configurations_workspace_idx" ON "no_code_workspace_configurations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "no_code_workspace_configurations_module_idx" ON "no_code_workspace_configurations" USING btree ("no_code_module_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_client_projects_idx" ON "oauth_client_projects" USING btree ("oauth_client_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_token_ttl_policies_org_type_idx" ON "org_token_ttl_policies" USING btree ("org_id","token_type");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_membership_roles_membership_role_idx" ON "organization_membership_roles" USING btree ("membership_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_roles_org_name_idx" ON "organization_roles" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_set_exclusions_idx" ON "policy_set_exclusions" USING btree ("policy_set_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_set_project_exclusions_idx" ON "policy_set_project_exclusions" USING btree ("policy_set_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_set_projects_idx" ON "policy_set_projects" USING btree ("policy_set_id","project_id");--> statement-breakpoint
CREATE INDEX "policy_set_tag_selectors_pset_idx" ON "policy_set_tag_selectors" USING btree ("policy_set_id");--> statement-breakpoint
CREATE INDEX "policy_set_versions_set_created_idx" ON "policy_set_versions" USING btree ("policy_set_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_set_workspaces_idx" ON "policy_set_workspaces" USING btree ("policy_set_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_tags_project_key_idx" ON "project_tags" USING btree ("project_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_name_idx" ON "projects" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_default_idx" ON "projects" USING btree ("org_id") WHERE "projects"."is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_sets_org_name_idx" ON "provider_sets" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "refresh_sessions_family_idx" ON "refresh_sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "refresh_sessions_user_idx" ON "refresh_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_gpg_keys_namespace_key_idx" ON "registry_gpg_keys" USING btree ("namespace","key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_module_versions_mod_ver_idx" ON "registry_module_versions" USING btree ("module_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_modules_ns_name_provider_idx" ON "registry_modules" USING btree ("namespace","name","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_partnerships_producer_consumer_idx" ON "registry_partnerships" USING btree ("producer_org_id","consumer_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_provider_platforms_ver_os_arch_idx" ON "registry_provider_platforms" USING btree ("version_id","os","arch");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_provider_versions_prov_ver_idx" ON "registry_provider_versions" USING btree ("provider_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_providers_ns_type_idx" ON "registry_providers" USING btree ("namespace","type");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_state_consumers_ws_consumer_idx" ON "remote_state_consumers" USING btree ("workspace_id","consumer_workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reserved_tag_keys_org_key_idx" ON "reserved_tag_keys" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "run_explanations_run_kind_idx" ON "run_explanations" USING btree ("run_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "run_triggers_ws_src_idx" ON "run_triggers" USING btree ("workspace_id","source_workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_group_memberships_group_user_idx" ON "scim_group_memberships" USING btree ("group_id","scim_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_groups_name_idx" ON "scim_groups" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_groups_external_id_idx" ON "scim_groups" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_user_identities_user_idx" ON "scim_user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_user_identities_username_idx" ON "scim_user_identities" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_user_identities_external_id_idx" ON "scim_user_identities" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_keys_org_name_idx" ON "ssh_keys" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "sso_challenges_kind_expires_idx" ON "sso_challenges" USING btree ("kind","expires_at");--> statement-breakpoint
CREATE INDEX "sso_challenges_expires_idx" ON "sso_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "state_versions_ws_serial_idx" ON "state_versions" USING btree ("workspace_id","serial");--> statement-breakpoint
CREATE UNIQUE INDEX "team_memberships_team_user_idx" ON "team_memberships" USING btree ("team_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_projects_team_project_idx" ON "team_projects" USING btree ("team_id","project_id");--> statement-breakpoint
CREATE INDEX "team_scim_group_mappings_group_idx" ON "team_scim_group_mappings" USING btree ("scim_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_workspaces_team_workspace_idx" ON "team_workspaces" USING btree ("team_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_org_name_idx" ON "teams" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "test_variables_module_key_idx" ON "test_variables" USING btree ("module_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "users_sso_identity_idx" ON "users" USING btree ("sso_provider","sso_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "variable_set_projects_idx" ON "variable_set_projects" USING btree ("variable_set_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "variable_set_variables_idx" ON "variable_set_variables" USING btree ("variable_set_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "variable_set_workspaces_idx" ON "variable_set_workspaces" USING btree ("variable_set_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_run_tasks_idx" ON "workspace_run_tasks" USING btree ("workspace_id","run_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_tags_workspace_key_idx" ON "workspace_tags" USING btree ("workspace_id","key");