CREATE TABLE "api_idempotency_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"principal" text NOT NULL,
	"request_hash" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"response_status" bigint,
	"response_body" jsonb,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_idempotency_scope_key_idx" ON "api_idempotency_keys" USING btree ("scope","key");--> statement-breakpoint
CREATE INDEX "api_idempotency_expires_idx" ON "api_idempotency_keys" USING btree ("expires_at");