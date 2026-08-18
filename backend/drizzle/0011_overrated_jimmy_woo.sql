CREATE TABLE `stack_records` (
	`id` text PRIMARY KEY NOT NULL,
	`stack_id` text NOT NULL,
	`parent_id` text,
	`record_type` text NOT NULL,
	`name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stack_records_stack_type_idx` ON `stack_records` (`stack_id`,`record_type`);--> statement-breakpoint
CREATE INDEX `stack_records_parent_type_idx` ON `stack_records` (`parent_id`,`record_type`);