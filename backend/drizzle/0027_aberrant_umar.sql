CREATE TABLE `identity_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`email_at_link_time` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_links_provider_external_idx` ON `identity_links` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `identity_links_user_idx` ON `identity_links` (`user_id`);--> statement-breakpoint
CREATE TABLE `organization_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`email_normalized` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text,
	`expires_at` integer NOT NULL,
	`created_by` text,
	`accepted_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`accepted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_invitations_token_hash_unique` ON `organization_invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `organization_invitations_org_idx` ON `organization_invitations` (`org_id`);--> statement-breakpoint
CREATE INDEX `organization_invitations_email_normalized_idx` ON `organization_invitations` (`email_normalized`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_invitations_org_email_pending_idx` ON `organization_invitations` (`org_id`,`email_normalized`) WHERE "organization_invitations"."status" = 'pending';--> statement-breakpoint
ALTER TABLE `users` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `deleted_email_hash` text;