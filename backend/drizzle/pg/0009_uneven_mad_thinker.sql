CREATE TABLE "module_test_configuration_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"module_id" text NOT NULL,
	"archive_path" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" bigint NOT NULL,
	"uploaded_at" bigint
);
--> statement-breakpoint
CREATE TABLE "module_test_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"module_id" text NOT NULL,
	"version_id" text NOT NULL,
	"configuration_version_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"test_status" text,
	"tests_passed" bigint,
	"tests_failed" bigint,
	"tests_errored" bigint,
	"tests_skipped" bigint,
	"verbose" boolean DEFAULT false NOT NULL,
	"filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"test_directory" text DEFAULT 'tests' NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text DEFAULT 'tfe-api' NOT NULL,
	"message" text,
	"output" text,
	"error" text,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "module_test_configurations" ADD COLUMN "oidc_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "module_test_configurations" ADD COLUMN "oidc_provider" text;--> statement-breakpoint
ALTER TABLE "module_test_configurations" ADD COLUMN "oidc_configuration" jsonb;--> statement-breakpoint
ALTER TABLE "module_test_configuration_versions" ADD CONSTRAINT "module_test_configuration_versions_module_id_registry_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."registry_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_test_runs" ADD CONSTRAINT "module_test_runs_module_id_registry_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."registry_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_test_runs" ADD CONSTRAINT "module_test_runs_version_id_registry_module_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."registry_module_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_test_runs" ADD CONSTRAINT "module_test_runs_configuration_version_id_module_test_configuration_versions_id_fk" FOREIGN KEY ("configuration_version_id") REFERENCES "public"."module_test_configuration_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_test_runs" ADD CONSTRAINT "module_test_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "module_test_configuration_versions_module_created_idx" ON "module_test_configuration_versions" USING btree ("module_id","created_at");--> statement-breakpoint
CREATE INDEX "module_test_runs_module_created_idx" ON "module_test_runs" USING btree ("module_id","created_at");--> statement-breakpoint
CREATE INDEX "module_test_runs_version_created_idx" ON "module_test_runs" USING btree ("version_id","created_at");