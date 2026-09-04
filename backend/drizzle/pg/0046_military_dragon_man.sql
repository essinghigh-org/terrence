ALTER TABLE "agent_pool_tokens" ADD COLUMN "expires_at" bigint;--> statement-breakpoint
ALTER TABLE "agent_pool_tokens" ADD COLUMN "revoked_at" bigint;--> statement-breakpoint
ALTER TABLE "user_2fa" ADD COLUMN "last_accepted_counter" bigint;