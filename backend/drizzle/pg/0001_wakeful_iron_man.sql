ALTER TABLE "admin_opa_versions" ADD CONSTRAINT "admin_opa_versions_version_unique" UNIQUE("version");--> statement-breakpoint
ALTER TABLE "admin_sentinel_versions" ADD CONSTRAINT "admin_sentinel_versions_version_unique" UNIQUE("version");--> statement-breakpoint
ALTER TABLE "admin_terraform_versions" ADD CONSTRAINT "admin_terraform_versions_version_unique" UNIQUE("version");--> statement-breakpoint
ALTER TABLE "agent_pool_tokens" ADD CONSTRAINT "agent_pool_tokens_token_unique" UNIQUE("token");--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_token_unique" UNIQUE("token");--> statement-breakpoint
ALTER TABLE "data_retention_policies" ADD CONSTRAINT "data_retention_policies_workspace_id_unique" UNIQUE("workspace_id");--> statement-breakpoint
ALTER TABLE "oauth_device_codes" ADD CONSTRAINT "oauth_device_codes_user_code_unique" UNIQUE("user_code");--> statement-breakpoint
ALTER TABLE "organization_data_retention_policies" ADD CONSTRAINT "organization_data_retention_policies_organization_id_unique" UNIQUE("organization_id");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_name_unique" UNIQUE("name");--> statement-breakpoint
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_token_hash_unique" UNIQUE("token_hash");--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_token_hash_unique" UNIQUE("token_hash");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_username_unique" UNIQUE("username");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE("email");