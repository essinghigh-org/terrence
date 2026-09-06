CREATE TABLE `outbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_events_status_updated_idx` ON `outbox_events` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `outbox_events_topic_status_idx` ON `outbox_events` (`topic`,`status`);