CREATE TABLE `control_events` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_node_id` text NOT NULL,
	`origin_instance_id` text NOT NULL,
	`topic` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `control_events_created_idx` ON `control_events` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `control_events_topic_created_idx` ON `control_events` (`topic`,`created_at`);--> statement-breakpoint
CREATE TABLE `control_plane_leases` (
	`name` text PRIMARY KEY NOT NULL,
	`owner_node_id` text NOT NULL,
	`owner_instance_id` text NOT NULL,
	`fencing_epoch` integer DEFAULT 1 NOT NULL,
	`expires_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `control_plane_leases_expires_idx` ON `control_plane_leases` (`expires_at`);--> statement-breakpoint
ALTER TABLE `control_plane_nodes` ADD `instance_id` text;--> statement-breakpoint
ALTER TABLE `control_plane_nodes` ADD `role` text DEFAULT 'standalone' NOT NULL;--> statement-breakpoint
ALTER TABLE `control_plane_nodes` ADD `coordinator_epoch` integer;