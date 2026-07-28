CREATE TABLE IF NOT EXISTS `github_app_installations` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `installation_id` integer NOT NULL,
  `icon_url` text,
  `installation_type` text DEFAULT 'Organization',
  `installation_url` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `github_app_installations_scoped` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `name` text NOT NULL,
  `installation_id` integer NOT NULL,
  `icon_url` text,
  `installation_type` text DEFAULT 'Organization',
  `installation_url` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `github_app_installations_scoped`
SELECT installation.id, MIN(workspace.org_id), installation.name, installation.installation_id,
       installation.icon_url, installation.installation_type, installation.installation_url, installation.created_at
FROM `github_app_installations` installation
JOIN `workspaces` workspace
  ON json_extract(workspace.vcs_repo, '$.githubAppInstallationId') = installation.id
GROUP BY installation.id;
--> statement-breakpoint
DROP TABLE `github_app_installations`;
--> statement-breakpoint
ALTER TABLE `github_app_installations_scoped` RENAME TO `github_app_installations`;
--> statement-breakpoint
CREATE UNIQUE INDEX `github_app_installations_org_installation_idx`
  ON `github_app_installations` (`org_id`, `installation_id`);
--> statement-breakpoint
CREATE INDEX `workspaces_vcs_repo_identifier_idx`
  ON `workspaces` (json_extract(`vcs_repo`, '$.identifier'));
--> statement-breakpoint
CREATE TABLE `github_webhook_deliveries` (
  `id` text PRIMARY KEY NOT NULL,
  `status` text DEFAULT 'processing' NOT NULL,
  `received_at` integer NOT NULL,
  `processed_at` integer
);
