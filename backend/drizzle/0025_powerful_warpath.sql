CREATE TABLE IF NOT EXISTS `locks` (
	`name` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `locks_expires_idx` ON `locks` (`expires_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `oauth_handshake_states` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `oauth_handshake_states_expires_idx` ON `oauth_handshake_states` (`expires_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `registry_sync_leases` (
	`key` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `registry_sync_leases_expires_idx` ON `registry_sync_leases` (`expires_at`);--> statement-breakpoint
ALTER TABLE `refresh_sessions` ADD `mfa_verified` integer DEFAULT false NOT NULL;