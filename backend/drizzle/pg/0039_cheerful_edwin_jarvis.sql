CREATE INDEX "organization_memberships_user_idx" ON "organization_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "policy_checks_run_idx" ON "policy_checks" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "policy_evaluations_run_idx" ON "policy_evaluations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_task_results_run_idx" ON "run_task_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "runs_configuration_version_idx" ON "runs" USING btree ("configuration_version_id");--> statement-breakpoint
CREATE INDEX "state_versions_run_idx" ON "state_versions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "task_stages_run_idx" ON "task_stages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "team_memberships_user_idx" ON "team_memberships" USING btree ("user_id");