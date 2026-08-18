CREATE TABLE "run_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	CONSTRAINT "run_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "registry_module_versions" ADD COLUMN "commit_sha" text;--> statement-breakpoint
ALTER TABLE "registry_module_versions" ADD COLUMN "vcs_tag" text;--> statement-breakpoint
ALTER TABLE "registry_module_versions" ADD COLUMN "vcs_branch" text;--> statement-breakpoint
ALTER TABLE "registry_module_versions" ADD COLUMN "source_directory" text;--> statement-breakpoint
ALTER TABLE "registry_module_versions" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "registry_module_versions" ADD COLUMN "ingest_error" text;--> statement-breakpoint
ALTER TABLE "registry_module_versions" ADD COLUMN "published_at" bigint;--> statement-breakpoint
ALTER TABLE "registry_module_versions" ADD COLUMN "updated_at" bigint;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD COLUMN "publishing_mechanism" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD COLUMN "publishing_workflow" text;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD COLUMN "vcs_connection_type" text;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD COLUMN "vcs_connection_id" text;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD COLUMN "repository_identifier" text;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD COLUMN "repository_display_identifier" text;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD COLUMN "repository_url" text;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD COLUMN "source_directory" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD COLUMN "tag_prefix" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD COLUMN "last_successful_sync_at" bigint;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD COLUMN "last_sync_attempt_at" bigint;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD COLUMN "last_sync_error" text;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD COLUMN "updated_at" bigint;--> statement-breakpoint
ALTER TABLE "run_tokens" ADD CONSTRAINT "run_tokens_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tokens" ADD CONSTRAINT "run_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tokens" ADD CONSTRAINT "run_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_tokens_run_id_idx" ON "run_tokens" USING btree ("run_id");