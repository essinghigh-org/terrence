ALTER TABLE `api_tokens` ADD `legacy` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `configuration_versions` ADD `upload_claim_expires_at` integer;--> statement-breakpoint
ALTER TABLE `refresh_sessions` ADD `successor_hash` text;--> statement-breakpoint
ALTER TABLE `refresh_sessions` ADD `rotated_at_ms` integer;--> statement-breakpoint
ALTER TABLE `user_2fa` ADD `secret_encrypted` text;--> statement-breakpoint
ALTER TABLE `users` ADD `is_provisional` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `variable_set_variables` ADD `value_encrypted` text;--> statement-breakpoint
ALTER TABLE `workspace_variables` ADD `value_encrypted` text;