ALTER TABLE `agent_pool_tokens` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `agent_pool_tokens` ADD `revoked_at` integer;--> statement-breakpoint
ALTER TABLE `user_2fa` ADD `last_accepted_counter` integer;