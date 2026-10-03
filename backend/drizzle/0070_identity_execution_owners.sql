PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workload_identity_tokens` (
	`jti` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`execution_id` text,
	`module_test_run_id` text,
	`assessment_result_id` text,
	`key_id` text NOT NULL,
	`audience` text NOT NULL,
	`subject` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`module_test_run_id`) REFERENCES `module_test_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assessment_result_id`) REFERENCES `assessment_results`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_workload_identity_tokens`("jti", "run_id", "execution_id", "module_test_run_id", "assessment_result_id", "key_id", "audience", "subject", "issued_at", "expires_at", "revoked_at") SELECT "jti", "run_id", "execution_id", "module_test_run_id", "assessment_result_id", "key_id", "audience", "subject", "issued_at", "expires_at", "revoked_at" FROM `workload_identity_tokens`;--> statement-breakpoint
DROP TABLE `workload_identity_tokens`;--> statement-breakpoint
ALTER TABLE `__new_workload_identity_tokens` RENAME TO `workload_identity_tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `workload_identity_tokens_run_idx` ON `workload_identity_tokens` (`run_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `workload_identity_tokens_expiry_idx` ON `workload_identity_tokens` (`expires_at`,`revoked_at`);