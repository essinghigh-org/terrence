CREATE INDEX "agents_last_ping_at_status_idx" ON "agents" USING btree ("last_ping_at","status");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_at_idx" ON "audit_logs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("resource_type","resource_id","created_at","id");--> statement-breakpoint
CREATE INDEX "run_comments_run_created_idx" ON "run_comments" USING btree ("run_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_variables_workspace_key_idx" ON "workspace_variables" USING btree ("workspace_id","category","key");