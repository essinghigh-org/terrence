ALTER TABLE "control_plane_nodes" ADD COLUMN "protocol_version" bigint;--> statement-breakpoint
ALTER TABLE "control_plane_nodes" ADD COLUMN "min_protocol_version" bigint;--> statement-breakpoint
ALTER TABLE "control_plane_nodes" ADD COLUMN "schema_version" text;--> statement-breakpoint
ALTER TABLE "control_plane_nodes" ADD COLUMN "drain_requested_at" bigint;--> statement-breakpoint
ALTER TABLE "control_plane_nodes" ADD COLUMN "drain_requested_by" text;--> statement-breakpoint
ALTER TABLE "control_plane_nodes" ADD COLUMN "drain_reason" text;--> statement-breakpoint
ALTER TABLE "control_plane_nodes" ADD COLUMN "drained_at" bigint;