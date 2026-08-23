CREATE TABLE "action_invocations" (
	"id" text PRIMARY KEY NOT NULL,
	"action_id" text NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text,
	"stack_id" text,
	"deployment_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"output" jsonb,
	"error_message" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "actions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"action_type" text DEFAULT 'custom' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_components" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"namespace" text DEFAULT 'hashicorp' NOT NULL,
	"description" text,
	"source" text DEFAULT 'registry' NOT NULL,
	"source_identifier" text NOT NULL,
	"version" text DEFAULT '0.1.0' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"published_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
ALTER TABLE "action_invocations" ADD CONSTRAINT "action_invocations_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_invocations" ADD CONSTRAINT "action_invocations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_invocations" ADD CONSTRAINT "action_invocations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_invocations" ADD CONSTRAINT "action_invocations_stack_id_stacks_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."stacks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_components" ADD CONSTRAINT "registry_components_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_invocations_org_idx" ON "action_invocations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "action_invocations_run_idx" ON "action_invocations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "action_invocations_stack_idx" ON "action_invocations" USING btree ("stack_id");--> statement-breakpoint
CREATE INDEX "action_invocations_action_idx" ON "action_invocations" USING btree ("action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "actions_org_name_idx" ON "actions" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_components_org_ns_name_idx" ON "registry_components" USING btree ("org_id","namespace","name");