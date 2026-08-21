CREATE TABLE "identity_links" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"email_at_link_time" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text,
	"expires_at" bigint NOT NULL,
	"created_by" text,
	"accepted_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "organization_invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_email_hash" text;--> statement-breakpoint
ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_links_provider_external_idx" ON "identity_links" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "identity_links_user_idx" ON "identity_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "organization_invitations_org_idx" ON "organization_invitations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "organization_invitations_email_normalized_idx" ON "organization_invitations" USING btree ("email_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_invitations_org_email_pending_idx" ON "organization_invitations" USING btree ("org_id","email_normalized") WHERE "organization_invitations"."status" = 'pending';