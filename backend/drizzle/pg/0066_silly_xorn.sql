CREATE TABLE "backup_rehearsal_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint,
	"result" jsonb DEFAULT 'null'::jsonb,
	"error" jsonb DEFAULT 'null'::jsonb,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "backup_rehearsal_jobs_status_started_idx" ON "backup_rehearsal_jobs" USING btree ("status","started_at");