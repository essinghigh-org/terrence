CREATE TABLE `assessment_results` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`succeeded` integer,
	`drifted` integer,
	`error_message` text,
	`resources_drifted` integer DEFAULT 0 NOT NULL,
	`resources_undrifted` integer DEFAULT 0 NOT NULL,
	`all_checks_succeeded` integer,
	`checks_passed` integer DEFAULT 0 NOT NULL,
	`checks_failed` integer DEFAULT 0 NOT NULL,
	`checks_errored` integer DEFAULT 0 NOT NULL,
	`checks_unknown` integer DEFAULT 0 NOT NULL,
	`json_output` text,
	`json_schema` text,
	`log_output` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `assessment_results_workspace_created_idx` ON `assessment_results` (`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `check_results` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`assessment_result_id` text,
	`run_id` text,
	`address` text NOT NULL,
	`kind` text DEFAULT 'check' NOT NULL,
	`status` text NOT NULL,
	`message` text,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assessment_result_id`) REFERENCES `assessment_results`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `check_results_assessment_idx` ON `check_results` (`assessment_result_id`);
--> statement-breakpoint
CREATE INDEX `check_results_run_idx` ON `check_results` (`run_id`);
