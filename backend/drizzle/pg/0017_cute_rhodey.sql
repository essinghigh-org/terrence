CREATE TABLE "control_plane_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"address" text,
	"version" text,
	"status" text DEFAULT 'active' NOT NULL,
	"registered_at" bigint NOT NULL,
	"last_heartbeat_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_configuration_workspace_exclusions" (
	"id" text PRIMARY KEY NOT NULL,
	"notification_configuration_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"description" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"last_used_at" bigint,
	"revoked_at" bigint,
	CONSTRAINT "system_api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "notification_configurations" ADD COLUMN "email_all_members" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_configurations" ADD COLUMN "email_user_ids" jsonb;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "cost_estimation_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "session_timeout" bigint;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "session_remember" boolean;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "collaborator_auth_policy" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "user_tokens_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "default_agent_pool_id" text;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "kind" text DEFAULT 'sentinel' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "operation" text DEFAULT 'plan_and_apply' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "generated_configuration" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "execution_mode" text DEFAULT 'remote' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_projects" ADD COLUMN "organization_id" text;--> statement-breakpoint
UPDATE "team_projects" AS tp SET "organization_id" = p."org_id" FROM "projects" AS p WHERE p."id" = tp."project_id" AND tp."organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "variable_set_variables" ADD COLUMN "hcl" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "notification_configuration_workspace_exclusions" ADD CONSTRAINT "notification_configuration_workspace_exclusions_notification_configuration_id_notification_configurations_id_fk" FOREIGN KEY ("notification_configuration_id") REFERENCES "public"."notification_configurations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_configuration_workspace_exclusions" ADD CONSTRAINT "notification_configuration_workspace_exclusions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "control_plane_nodes_hostname_idx" ON "control_plane_nodes" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "control_plane_nodes_heartbeat_idx" ON "control_plane_nodes" USING btree ("status","last_heartbeat_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_configuration_workspace_exclusions_idx" ON "notification_configuration_workspace_exclusions" USING btree ("notification_configuration_id","workspace_id");--> statement-breakpoint
ALTER TABLE "team_projects" ADD CONSTRAINT "team_projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;