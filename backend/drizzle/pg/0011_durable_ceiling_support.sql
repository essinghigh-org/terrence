CREATE TABLE "durable_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"run_after" bigint NOT NULL,
	"locked_by" text,
	"lock_token" text,
	"lease_expires_at" bigint,
	"heartbeat_at" bigint,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "explorer_catalog_items" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"version" text NOT NULL,
	"workspace_count" bigint DEFAULT 0 NOT NULL,
	"workspaces" text DEFAULT '' NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "explorer_workspace_inventory" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"workspace_name" text NOT NULL,
	"workspace_created_at" bigint NOT NULL,
	"workspace_updated_at" bigint NOT NULL,
	"terraform_version" text,
	"execution_mode" text,
	"vcs_repo_identifier" text,
	"project_id" text,
	"project_name" text,
	"current_run_status" text,
	"current_run_applied_at" bigint,
	"current_run_external_id" text,
	"current_resource_count" bigint DEFAULT 0 NOT NULL,
	"drifted" boolean,
	"resources_drifted" bigint DEFAULT 0 NOT NULL,
	"resources_undrifted" bigint DEFAULT 0 NOT NULL,
	"all_checks_succeeded" boolean,
	"checks_passed" bigint DEFAULT 0 NOT NULL,
	"checks_failed" bigint DEFAULT 0 NOT NULL,
	"checks_errored" bigint DEFAULT 0 NOT NULL,
	"checks_unknown" bigint DEFAULT 0 NOT NULL,
	"tags" text DEFAULT '' NOT NULL,
	"providers" text DEFAULT '' NOT NULL,
	"modules" text DEFAULT '' NOT NULL,
	"provider_items" text DEFAULT '[]' NOT NULL,
	"module_items" text DEFAULT '[]' NOT NULL,
	"provider_count" bigint DEFAULT 0 NOT NULL,
	"module_count" bigint DEFAULT 0 NOT NULL,
	"state_version_terraform_version" text,
	"state_serial" bigint,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workload_identity_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL,
	"retired_at" bigint,
	"revoked_at" bigint,
	CONSTRAINT "workload_identity_keys_key_id_unique" UNIQUE("key_id")
);
--> statement-breakpoint
CREATE TABLE "workload_identity_tokens" (
	"jti" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"key_id" text NOT NULL,
	"audience" text NOT NULL,
	"subject" text NOT NULL,
	"issued_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint
);
--> statement-breakpoint
ALTER TABLE "module_test_runs" ADD COLUMN "oidc_token_generated_at" bigint;--> statement-breakpoint
ALTER TABLE "module_test_runs" ADD COLUMN "oidc_token_expires_at" bigint;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "module_test_token_ttl" bigint DEFAULT 600 NOT NULL;--> statement-breakpoint
ALTER TABLE "stacks" ADD COLUMN "trigger_disabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stacks" ADD COLUMN "debugging_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stacks" ADD COLUMN "vcs_service_provider" text;--> statement-breakpoint
ALTER TABLE "stacks" ADD COLUMN "vcs_tags_regex" text;--> statement-breakpoint
ALTER TABLE "stacks" ADD COLUMN "vcs_display_identifier" text;--> statement-breakpoint
ALTER TABLE "stacks" ADD COLUMN "vcs_repository_http_url" text;--> statement-breakpoint
ALTER TABLE "stacks" ADD COLUMN "vcs_sparse_checkout_pattern" text;--> statement-breakpoint
ALTER TABLE "explorer_catalog_items" ADD CONSTRAINT "explorer_catalog_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explorer_workspace_inventory" ADD CONSTRAINT "explorer_workspace_inventory_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explorer_workspace_inventory" ADD CONSTRAINT "explorer_workspace_inventory_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "durable_jobs_kind_status_run_after_idx" ON "durable_jobs" USING btree ("kind","status","run_after");--> statement-breakpoint
CREATE INDEX "durable_jobs_kind_dedupe_idx" ON "durable_jobs" USING btree ("kind","dedupe_key","status");--> statement-breakpoint
CREATE INDEX "durable_jobs_lease_idx" ON "durable_jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "explorer_catalog_org_kind_key_idx" ON "explorer_catalog_items" USING btree ("org_id","kind","name","source","version");--> statement-breakpoint
CREATE INDEX "explorer_catalog_org_kind_idx" ON "explorer_catalog_items" USING btree ("org_id","kind","name");--> statement-breakpoint
CREATE INDEX "explorer_inventory_org_name_idx" ON "explorer_workspace_inventory" USING btree ("org_id","workspace_name");--> statement-breakpoint
CREATE INDEX "explorer_inventory_org_updated_idx" ON "explorer_workspace_inventory" USING btree ("org_id","workspace_updated_at");--> statement-breakpoint
CREATE INDEX "workload_identity_tokens_run_idx" ON "workload_identity_tokens" USING btree ("run_id","expires_at");--> statement-breakpoint
CREATE INDEX "workload_identity_tokens_expiry_idx" ON "workload_identity_tokens" USING btree ("expires_at","revoked_at");