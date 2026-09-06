CREATE TABLE `api_idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`principal` text NOT NULL,
	`request_hash` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`response_status` integer,
	`response_body` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_idempotency_scope_key_idx` ON `api_idempotency_keys` (`scope`,`key`);--> statement-breakpoint
CREATE INDEX `api_idempotency_expires_idx` ON `api_idempotency_keys` (`expires_at`);