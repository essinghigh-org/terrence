CREATE TABLE "state_output_index" (
	"output_id" text PRIMARY KEY NOT NULL,
	"state_version_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "state_output_index" ADD CONSTRAINT "state_output_index_state_version_id_state_versions_id_fk" FOREIGN KEY ("state_version_id") REFERENCES "public"."state_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_output_index" ADD CONSTRAINT "state_output_index_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "state_output_index_workspace_idx" ON "state_output_index" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "state_output_index_state_idx" ON "state_output_index" USING btree ("state_version_id");