ALTER TABLE "runs" ADD COLUMN "invoke_action_addrs" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_id_org_idx" ON "projects" USING btree ("id","org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_id_org_idx" ON "teams" USING btree ("id","org_id");