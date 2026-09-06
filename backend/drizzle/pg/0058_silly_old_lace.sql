ALTER TABLE "assessment_results" ADD COLUMN "artifact_schema_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "configuration_versions" ADD COLUMN "status_metadata_schema_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "durable_jobs" ADD COLUMN "payload_schema_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_evaluations" ADD COLUMN "status_metadata_schema_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_set_versions" ADD COLUMN "status_metadata_schema_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "input_schema_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "status_metadata_schema_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stack_agent_jobs" ADD COLUMN "result_schema_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stack_records" ADD COLUMN "payload_schema_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_stages" ADD COLUMN "status_metadata_schema_version" bigint DEFAULT 0 NOT NULL;