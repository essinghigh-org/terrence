CREATE TABLE `scim_groups` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `external_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_groups_name_idx` ON `scim_groups` (`name` COLLATE NOCASE);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_groups_external_id_idx` ON `scim_groups` (`external_id`);
--> statement-breakpoint
CREATE TABLE `scim_user_identities` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `username` text NOT NULL,
  `external_id` text,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_user_identities_user_idx` ON `scim_user_identities` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_user_identities_username_idx` ON `scim_user_identities` (`username` COLLATE NOCASE);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_user_identities_external_id_idx` ON `scim_user_identities` (`external_id`);
--> statement-breakpoint
CREATE TABLE `scim_group_memberships` (
  `id` text PRIMARY KEY NOT NULL,
  `group_id` text NOT NULL,
  `scim_user_id` text NOT NULL,
  FOREIGN KEY (`group_id`) REFERENCES `scim_groups`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`scim_user_id`) REFERENCES `scim_user_identities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_group_memberships_group_user_idx` ON `scim_group_memberships` (`group_id`, `scim_user_id`);
--> statement-breakpoint
CREATE TABLE `scim_settings` (
  `id` text PRIMARY KEY NOT NULL,
  `enabled` integer DEFAULT false NOT NULL,
  `paused` integer DEFAULT false NOT NULL,
  `site_admin_group_scim_id` text,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`site_admin_group_scim_id`) REFERENCES `scim_groups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `scim_tokens` (
  `id` text PRIMARY KEY NOT NULL,
  `token_hash` text NOT NULL,
  `description` text,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_tokens_token_hash_unique` ON `scim_tokens` (`token_hash`);
--> statement-breakpoint
CREATE TABLE `team_scim_group_mappings` (
  `team_id` text PRIMARY KEY NOT NULL,
  `scim_group_id` text NOT NULL,
  `sync_paused` integer DEFAULT false NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`scim_group_id`) REFERENCES `scim_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_scim_group_mappings_group_idx` ON `team_scim_group_mappings` (`scim_group_id`);
