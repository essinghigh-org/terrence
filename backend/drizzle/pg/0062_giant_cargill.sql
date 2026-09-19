ALTER TABLE "runs" ADD COLUMN "execution_owner_node_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "execution_owner_instance_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "execution_fencing_token" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "execution_lease_expires_at" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "execution_lease_heartbeat_at" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "execution_phase" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "execution_run_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "execution_owner_node_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "execution_owner_instance_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "execution_fencing_token" bigint;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "execution_lease_expires_at" bigint;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "execution_lease_heartbeat_at" bigint;