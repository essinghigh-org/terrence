CREATE TABLE "control_events" (
	"id" text PRIMARY KEY NOT NULL,
	"origin_node_id" text NOT NULL,
	"origin_instance_id" text NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_plane_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"owner_node_id" text NOT NULL,
	"owner_instance_id" text NOT NULL,
	"fencing_epoch" bigint DEFAULT 1 NOT NULL,
	"expires_at" bigint NOT NULL,
	"heartbeat_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "control_plane_nodes" ADD COLUMN "instance_id" text;--> statement-breakpoint
ALTER TABLE "control_plane_nodes" ADD COLUMN "role" text DEFAULT 'standalone' NOT NULL;--> statement-breakpoint
ALTER TABLE "control_plane_nodes" ADD COLUMN "coordinator_epoch" bigint;--> statement-breakpoint
CREATE INDEX "control_events_created_idx" ON "control_events" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "control_events_topic_created_idx" ON "control_events" USING btree ("topic","created_at");--> statement-breakpoint
CREATE INDEX "control_plane_leases_expires_idx" ON "control_plane_leases" USING btree ("expires_at");