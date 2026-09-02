PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stack_state_locks` (
	`id` text PRIMARY KEY NOT NULL,
	`stack_id` text NOT NULL,
	`deployment` text NOT NULL,
	`run_id` text,
	`fencing_token` integer DEFAULT 0 NOT NULL,
	`acquired_at` integer,
	`lease_expires_at` integer,
	`released_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_stack_state_locks`("id", "stack_id", "deployment", "run_id", "fencing_token", "acquired_at", "lease_expires_at", "released_at", "updated_at") SELECT "id", "stack_id", "deployment", "run_id", "fencing_token", "acquired_at", "lease_expires_at", "released_at", "updated_at" FROM `stack_state_locks`;--> statement-breakpoint
DROP TABLE `stack_state_locks`;--> statement-breakpoint
ALTER TABLE `__new_stack_state_locks` RENAME TO `stack_state_locks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `stack_state_locks_stack_deployment_idx` ON `stack_state_locks` (`stack_id`,`deployment`);--> statement-breakpoint
CREATE INDEX `stack_state_locks_run_idx` ON `stack_state_locks` (`run_id`);