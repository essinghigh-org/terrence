CREATE TABLE `refresh_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token_id` text NOT NULL,
	`rotated_at` integer,
	`revoked_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_sessions_token_hash_unique` ON `refresh_sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `refresh_sessions_family_idx` ON `refresh_sessions` (`family_id`);
--> statement-breakpoint
CREATE INDEX `refresh_sessions_user_idx` ON `refresh_sessions` (`user_id`);
