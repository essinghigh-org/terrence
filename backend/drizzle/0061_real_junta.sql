ALTER TABLE `assessment_results` ADD `artifact_schema_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `configuration_versions` ADD `status_metadata_schema_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `durable_jobs` ADD `payload_schema_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `policy_evaluations` ADD `status_metadata_schema_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `policy_set_versions` ADD `status_metadata_schema_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `input_schema_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `status_metadata_schema_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `stack_agent_jobs` ADD `result_schema_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `stack_records` ADD `payload_schema_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `task_stages` ADD `status_metadata_schema_version` integer DEFAULT 0 NOT NULL;