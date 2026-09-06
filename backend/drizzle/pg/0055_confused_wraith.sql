CREATE TABLE "run_provenance_capsules" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"schema_version" bigint DEFAULT 1 NOT NULL,
	"public_manifest" jsonb NOT NULL,
	"manifest_sha256" text NOT NULL,
	"execution_material" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "run_provenance_capsules_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
ALTER TABLE "run_provenance_capsules" ADD CONSTRAINT "run_provenance_capsules_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_provenance_capsules_run_idx" ON "run_provenance_capsules" USING btree ("run_id");