CREATE TABLE `rate_limit_buckets` (
	`bucket` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_limit_buckets_window_idx` ON `rate_limit_buckets` (`window_start`);