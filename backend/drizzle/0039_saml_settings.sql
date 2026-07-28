ALTER TABLE `organizations` ADD `saml_enabled` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `organizations` ADD `owners_team_saml_role_id` text;
--> statement-breakpoint

CREATE TABLE `saml_settings` (
  `id` text PRIMARY KEY NOT NULL,
  `enabled` integer DEFAULT false NOT NULL,
  `debug` integer DEFAULT false NOT NULL,
  `old_idp_cert` text,
  `idp_cert` text,
  `slo_endpoint_url` text,
  `sso_endpoint_url` text,
  `attr_username` text DEFAULT 'Username' NOT NULL,
  `attr_groups` text DEFAULT 'MemberOf' NOT NULL,
  `attr_site_admin` text DEFAULT 'SiteAdmin' NOT NULL,
  `site_admin_role` text DEFAULT 'site-admins' NOT NULL,
  `sso_api_token_session_timeout` integer DEFAULT 1209600 NOT NULL,
  `updated_at` integer NOT NULL
);
