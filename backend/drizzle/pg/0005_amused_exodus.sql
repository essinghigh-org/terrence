ALTER TABLE "agent_jobs" ADD COLUMN "iac_binary" text DEFAULT 'terraform' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "iac_binaries" jsonb DEFAULT '["terraform"]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "configuration_versions_workspace_created_idx" ON "configuration_versions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_workspace_status_created_idx" ON "runs" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_status_created_idx" ON "runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_org_idx" ON "workspaces" USING btree ("org_id");