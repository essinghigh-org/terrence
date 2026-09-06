CREATE TABLE "outbox_events" (
	"id" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"last_error" text,
	"delivered_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "outbox_events_status_updated_idx" ON "outbox_events" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "outbox_events_topic_status_idx" ON "outbox_events" USING btree ("topic","status");