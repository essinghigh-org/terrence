ALTER TABLE `control_plane_nodes` ADD `protocol_version` integer;--> statement-breakpoint
ALTER TABLE `control_plane_nodes` ADD `min_protocol_version` integer;--> statement-breakpoint
ALTER TABLE `control_plane_nodes` ADD `schema_version` text;--> statement-breakpoint
ALTER TABLE `control_plane_nodes` ADD `drain_requested_at` integer;--> statement-breakpoint
ALTER TABLE `control_plane_nodes` ADD `drain_requested_by` text;--> statement-breakpoint
ALTER TABLE `control_plane_nodes` ADD `drain_reason` text;--> statement-breakpoint
ALTER TABLE `control_plane_nodes` ADD `drained_at` integer;