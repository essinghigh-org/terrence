ALTER TABLE `runs` ADD `execution_owner_node_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `execution_owner_instance_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `execution_fencing_token` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `execution_lease_expires_at` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `execution_lease_heartbeat_at` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `execution_phase` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `execution_run_id` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `execution_owner_node_id` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `execution_owner_instance_id` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `execution_fencing_token` integer;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `execution_lease_expires_at` integer;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `execution_lease_heartbeat_at` integer;