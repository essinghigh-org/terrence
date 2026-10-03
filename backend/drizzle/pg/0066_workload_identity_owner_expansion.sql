ALTER TABLE "workload_identity_tokens" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workload_identity_tokens" ADD COLUMN "execution_id" text;--> statement-breakpoint
ALTER TABLE "workload_identity_tokens" ADD COLUMN "module_test_run_id" text;--> statement-breakpoint
ALTER TABLE "workload_identity_tokens" ADD COLUMN "assessment_result_id" text;--> statement-breakpoint
ALTER TABLE "workload_identity_tokens" ADD CONSTRAINT "workload_identity_tokens_module_test_run_id_module_test_runs_id_fk" FOREIGN KEY ("module_test_run_id") REFERENCES "public"."module_test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workload_identity_tokens" ADD CONSTRAINT "workload_identity_tokens_assessment_result_id_assessment_results_id_fk" FOREIGN KEY ("assessment_result_id") REFERENCES "public"."assessment_results"("id") ON DELETE cascade ON UPDATE no action;