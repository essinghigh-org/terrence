PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stacks` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text,
	`agent_pool_id` text,
	`execution_mode` text DEFAULT 'remote' NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`speculative_enabled` integer DEFAULT false NOT NULL,
	`working_directory` text,
	`trigger_patterns` text DEFAULT '[]' NOT NULL,
	`trigger_disabled` integer DEFAULT false NOT NULL,
	`debugging_mode` integer DEFAULT false NOT NULL,
	`vcs_identifier` text,
	`vcs_service_provider` text,
	`vcs_branch` text,
	`vcs_tags_regex` text,
	`vcs_display_identifier` text,
	`vcs_repository_http_url` text,
	`vcs_sparse_checkout_pattern` text,
	`vcs_oauth_token_id` text,
	`vcs_gha_installation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`agent_pool_id`) REFERENCES `agent_pools`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_stacks`("id", "org_id", "project_id", "agent_pool_id", "execution_mode", "name", "description", "speculative_enabled", "working_directory", "trigger_patterns", "trigger_disabled", "debugging_mode", "vcs_identifier", "vcs_service_provider", "vcs_branch", "vcs_tags_regex", "vcs_display_identifier", "vcs_repository_http_url", "vcs_sparse_checkout_pattern", "vcs_oauth_token_id", "vcs_gha_installation_id", "created_at", "updated_at") SELECT "id", "org_id", "project_id", "agent_pool_id", "execution_mode", "name", "description", "speculative_enabled", "working_directory", "trigger_patterns", "trigger_disabled", "debugging_mode", "vcs_identifier", "vcs_service_provider", "vcs_branch", "vcs_tags_regex", "vcs_display_identifier", "vcs_repository_http_url", "vcs_sparse_checkout_pattern", "vcs_oauth_token_id", "vcs_gha_installation_id", "created_at", "updated_at" FROM `stacks`;--> statement-breakpoint
DROP TABLE `stacks`;--> statement-breakpoint
ALTER TABLE `__new_stacks` RENAME TO `stacks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;