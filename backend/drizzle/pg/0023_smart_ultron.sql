ALTER TABLE "api_tokens" ADD COLUMN "legacy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "configuration_versions" ADD COLUMN "upload_claim_expires_at" bigint;--> statement-breakpoint
ALTER TABLE "refresh_sessions" ADD COLUMN "successor_hash" text;--> statement-breakpoint
ALTER TABLE "refresh_sessions" ADD COLUMN "rotated_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "user_2fa" ADD COLUMN "secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_provisional" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "variable_set_variables" ADD COLUMN "value_encrypted" text;--> statement-breakpoint
ALTER TABLE "workspace_variables" ADD COLUMN "value_encrypted" text;