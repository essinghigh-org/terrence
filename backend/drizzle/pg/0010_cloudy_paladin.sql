ALTER TABLE "oauth_tokens" ADD COLUMN "ssh_key" text;--> statement-breakpoint
ALTER TABLE "scim_user_identities" ADD COLUMN "created_at" bigint;