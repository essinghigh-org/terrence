ALTER TABLE "workload_identity_tokens" ADD COLUMN "workspace_run_id" text;--> statement-breakpoint
ALTER TABLE "workload_identity_tokens" ADD COLUMN "module_test_run_id" text;--> statement-breakpoint
ALTER TABLE "workload_identity_tokens" ADD COLUMN "assessment_result_id" text;