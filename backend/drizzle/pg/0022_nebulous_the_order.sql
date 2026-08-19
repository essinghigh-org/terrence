CREATE TABLE "locks" (
	"name" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_handshake_states" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" bigint NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_sync_leases" (
	"key" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refresh_sessions" ADD COLUMN "mfa_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "locks_expires_idx" ON "locks" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_handshake_states_expires_idx" ON "oauth_handshake_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "registry_sync_leases_expires_idx" ON "registry_sync_leases" USING btree ("expires_at");