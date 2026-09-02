PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stack_agent_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`stack_id` text NOT NULL,
	`deployment_run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`agent_pool_id` text NOT NULL,
	`agent_id` text,
	`phase` text NOT NULL,
	`iac_binary` text DEFAULT 'terraform' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`result` text,
	`error_message` text,
	`claimed_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deployment_run_id`) REFERENCES `stack_records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `stack_records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_stack_agent_jobs`("id", "stack_id", "deployment_run_id", "step_id", "agent_pool_id", "agent_id", "phase", "iac_binary", "status", "result", "error_message", "claimed_at", "completed_at", "created_at", "updated_at") SELECT "id", "stack_id", "deployment_run_id", "step_id", "agent_pool_id", "agent_id", "phase", "iac_binary", "status", "result", "error_message", "claimed_at", "completed_at", "created_at", "updated_at" FROM `stack_agent_jobs`;--> statement-breakpoint
DROP TABLE `stack_agent_jobs`;--> statement-breakpoint
ALTER TABLE `__new_stack_agent_jobs` RENAME TO `stack_agent_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `stack_agent_jobs_step_phase_idx` ON `stack_agent_jobs` (`step_id`,`phase`);--> statement-breakpoint
CREATE INDEX `stack_agent_jobs_pool_status_created_idx` ON `stack_agent_jobs` (`agent_pool_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `stack_agent_jobs_run_status_idx` ON `stack_agent_jobs` (`deployment_run_id`,`status`);--> statement-breakpoint
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
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `stack_records`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_stack_state_locks`("id", "stack_id", "deployment", "run_id", "fencing_token", "acquired_at", "lease_expires_at", "released_at", "updated_at") SELECT "id", "stack_id", "deployment", "run_id", "fencing_token", "acquired_at", "lease_expires_at", "released_at", "updated_at" FROM `stack_state_locks`;--> statement-breakpoint
DROP TABLE `stack_state_locks`;--> statement-breakpoint
ALTER TABLE `__new_stack_state_locks` RENAME TO `stack_state_locks`;--> statement-breakpoint
CREATE UNIQUE INDEX `stack_state_locks_stack_deployment_idx` ON `stack_state_locks` (`stack_id`,`deployment`);--> statement-breakpoint
CREATE INDEX `stack_state_locks_run_idx` ON `stack_state_locks` (`run_id`);