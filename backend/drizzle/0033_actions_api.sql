CREATE TABLE `action_invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL,
	`org_id` text NOT NULL,
	`run_id` text,
	`stack_id` text,
	`deployment_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`output` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`action_id`) REFERENCES `actions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `action_invocations_org_idx` ON `action_invocations` (`org_id`);--> statement-breakpoint
CREATE INDEX `action_invocations_run_idx` ON `action_invocations` (`run_id`);--> statement-breakpoint
CREATE INDEX `action_invocations_stack_idx` ON `action_invocations` (`stack_id`);--> statement-breakpoint
CREATE INDEX `action_invocations_action_idx` ON `action_invocations` (`action_id`);--> statement-breakpoint
CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`action_type` text DEFAULT 'custom' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`configuration` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actions_org_name_idx` ON `actions` (`org_id`,`name`);