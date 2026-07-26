CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`service_provider` text DEFAULT 'github' NOT NULL,
	`api_url` text,
	`http_url` text,
	`key` text,
	`secret` text,
	`rsa_public_key` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`oauth_client_id` text NOT NULL,
	`service_provider_user` text,
	`token` text NOT NULL,
	`has_ssh_key` integer DEFAULT false,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`oauth_client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_set_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`enforcement_level` text DEFAULT 'soft-mandatory' NOT NULL,
	`query` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`policy_set_id`) REFERENCES `policy_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `policy_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `policy_set_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_set_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`policy_set_id`) REFERENCES `policy_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_set_workspaces_idx` ON `policy_set_workspaces` (`policy_set_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `policy_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text DEFAULT 'sentinel' NOT NULL,
	`global` integer DEFAULT false,
	`overridable` integer DEFAULT true,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
