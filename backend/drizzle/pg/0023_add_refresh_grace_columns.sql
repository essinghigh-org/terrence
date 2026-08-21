ALTER TABLE "refresh_sessions" ADD COLUMN IF NOT EXISTS "successor_hash" text;
--> statement-breakpoint
ALTER TABLE "refresh_sessions" ADD COLUMN IF NOT EXISTS "rotated_at_ms" bigint;
