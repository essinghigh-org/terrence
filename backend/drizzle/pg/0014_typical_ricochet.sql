CREATE TABLE "explorer_catalog_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"version" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stack_agent_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"stack_id" text NOT NULL,
	"deployment_run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"agent_pool_id" text NOT NULL,
	"agent_id" text,
	"phase" text NOT NULL,
	"iac_binary" text DEFAULT 'terraform' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"error_message" text,
	"claimed_at" bigint,
	"completed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stack_state_locks" (
	"id" text PRIMARY KEY NOT NULL,
	"stack_id" text NOT NULL,
	"deployment" text NOT NULL,
	"run_id" text,
	"fencing_token" bigint DEFAULT 0 NOT NULL,
	"acquired_at" bigint,
	"released_at" bigint,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workload_identity_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text,
	"lease_expires_at" bigint,
	"fencing_token" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "module_test_runs" ADD COLUMN "execution_pid" bigint;--> statement-breakpoint
ALTER TABLE "module_test_runs" ADD COLUMN "execution_started_at" bigint;--> statement-breakpoint
ALTER TABLE "module_test_runs" ADD COLUMN "execution_stage" text;--> statement-breakpoint
ALTER TABLE "module_test_runs" ADD COLUMN "execution_directory" text;--> statement-breakpoint
ALTER TABLE "module_test_runs" ADD COLUMN "execution_result_path" text;--> statement-breakpoint
ALTER TABLE "module_test_runs" ADD COLUMN "execution_token_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "stacks" ADD COLUMN "execution_mode" text DEFAULT 'remote' NOT NULL;--> statement-breakpoint
ALTER TABLE "explorer_catalog_memberships" ADD CONSTRAINT "explorer_catalog_memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explorer_catalog_memberships" ADD CONSTRAINT "explorer_catalog_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_agent_jobs" ADD CONSTRAINT "stack_agent_jobs_stack_id_stacks_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."stacks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_agent_jobs" ADD CONSTRAINT "stack_agent_jobs_agent_pool_id_agent_pools_id_fk" FOREIGN KEY ("agent_pool_id") REFERENCES "public"."agent_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_agent_jobs" ADD CONSTRAINT "stack_agent_jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_state_locks" ADD CONSTRAINT "stack_state_locks_stack_id_stacks_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."stacks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "explorer_catalog_membership_workspace_key_idx" ON "explorer_catalog_memberships" USING btree ("workspace_id","kind","name","source","version");--> statement-breakpoint
CREATE INDEX "explorer_catalog_membership_org_key_idx" ON "explorer_catalog_memberships" USING btree ("org_id","kind","name","source","version");--> statement-breakpoint
CREATE INDEX "explorer_catalog_membership_workspace_idx" ON "explorer_catalog_memberships" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stack_agent_jobs_step_phase_idx" ON "stack_agent_jobs" USING btree ("step_id","phase");--> statement-breakpoint
CREATE INDEX "stack_agent_jobs_pool_status_created_idx" ON "stack_agent_jobs" USING btree ("agent_pool_id","status","created_at");--> statement-breakpoint
CREATE INDEX "stack_agent_jobs_run_status_idx" ON "stack_agent_jobs" USING btree ("deployment_run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "stack_state_locks_stack_deployment_idx" ON "stack_state_locks" USING btree ("stack_id","deployment");--> statement-breakpoint
CREATE INDEX "stack_state_locks_run_idx" ON "stack_state_locks" USING btree ("run_id");