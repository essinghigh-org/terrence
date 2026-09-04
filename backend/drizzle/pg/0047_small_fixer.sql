ALTER TABLE "state_versions" DROP CONSTRAINT "state_versions_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "state_versions" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "login_failed_attempts" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "login_failure_window_started_at" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "login_locked_until" bigint;--> statement-breakpoint
ALTER TABLE "state_versions" ADD CONSTRAINT "state_versions_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_versions" ADD CONSTRAINT "state_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;