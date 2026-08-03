ALTER TABLE `saml_settings` ADD `idp_entity_id` text;
--> statement-breakpoint
CREATE TABLE `sso_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sso_challenges_kind_expires_idx` ON `sso_challenges` (`kind`, `expires_at`);
