ALTER TABLE "state_versions" ADD COLUMN "upload_expires_at" bigint;--> statement-breakpoint
ALTER TABLE "state_versions" ADD COLUMN "upload_lock" text;