CREATE TABLE "agent_forwarded_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_pool_id" text NOT NULL,
	"agent_id" text,
	"method" text NOT NULL,
	"url" text NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"response_status" bigint,
	"response_headers" jsonb,
	"response_body" text,
	"error_message" text,
	"claimed_at" bigint,
	"completed_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_workspace_counters" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"configuration_count" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "accept" text DEFAULT 'plan,apply,policy,assessment,stack_prepare,stack_plan,stack_apply,source_bundle,stack_aggregate_outputs,test' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "request_forwarding" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "hyok" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "control_plane_nodes" ADD COLUMN "readiness_checks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_forwarded_requests" ADD CONSTRAINT "agent_forwarded_requests_agent_pool_id_agent_pools_id_fk" FOREIGN KEY ("agent_pool_id") REFERENCES "public"."agent_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_forwarded_requests" ADD CONSTRAINT "agent_forwarded_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_workspace_counters" ADD CONSTRAINT "notification_workspace_counters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_forwarded_requests_pool_status_created_idx" ON "agent_forwarded_requests" USING btree ("agent_pool_id","status","created_at");