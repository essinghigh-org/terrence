ALTER TABLE "scim_settings" ADD COLUMN "site_auditor_group_scim_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "scim_site_auditor" boolean DEFAULT false NOT NULL;