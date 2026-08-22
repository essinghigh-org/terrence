CREATE TABLE `notification_delivery_state` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`state_key` text NOT NULL,
	`value` integer DEFAULT 0 NOT NULL,
	`window_start` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_delivery_state_kind_key_idx` ON `notification_delivery_state` (`kind`,`state_key`);--> statement-breakpoint
CREATE INDEX `notification_delivery_state_updated_idx` ON `notification_delivery_state` (`updated_at`);