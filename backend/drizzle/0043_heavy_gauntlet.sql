CREATE INDEX `organization_memberships_user_idx` ON `organization_memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX `policy_checks_run_idx` ON `policy_checks` (`run_id`);--> statement-breakpoint
CREATE INDEX `policy_evaluations_run_idx` ON `policy_evaluations` (`run_id`);--> statement-breakpoint
CREATE INDEX `run_task_results_run_idx` ON `run_task_results` (`run_id`);--> statement-breakpoint
CREATE INDEX `runs_configuration_version_idx` ON `runs` (`configuration_version_id`);--> statement-breakpoint
CREATE INDEX `state_versions_run_idx` ON `state_versions` (`run_id`);--> statement-breakpoint
CREATE INDEX `task_stages_run_idx` ON `task_stages` (`run_id`);--> statement-breakpoint
CREATE INDEX `team_memberships_user_idx` ON `team_memberships` (`user_id`);