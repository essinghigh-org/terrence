ALTER TABLE "user_2fa" ADD COLUMN IF NOT EXISTS "secret_encrypted" text;
--> statement-breakpoint
ALTER TABLE "configuration_versions" ADD COLUMN IF NOT EXISTS "upload_claim_expires_at" bigint;
--> statement-breakpoint
ALTER TABLE "workspace_variables" ADD COLUMN IF NOT EXISTS "value_encrypted" text;
--> statement-breakpoint
ALTER TABLE "variable_set_variables" ADD COLUMN IF NOT EXISTS "value_encrypted" text;
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "legacy" boolean NOT NULL DEFAULT false;
