PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stack_records` (
	`id` text PRIMARY KEY NOT NULL,
	`stack_id` text NOT NULL,
	`parent_id` text,
	`record_type` text NOT NULL,
	`name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `stack_records`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_stack_records`("id", "stack_id", "parent_id", "record_type", "name", "status", "payload", "created_at", "updated_at") SELECT "id", "stack_id", "parent_id", "record_type", "name", "status", "payload", "created_at", "updated_at" FROM `stack_records`;--> statement-breakpoint
DROP TABLE `stack_records`;--> statement-breakpoint
ALTER TABLE `__new_stack_records` RENAME TO `stack_records`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `stack_records_stack_type_idx` ON `stack_records` (`stack_id`,`record_type`);--> statement-breakpoint
CREATE INDEX `stack_records_parent_type_idx` ON `stack_records` (`parent_id`,`record_type`);