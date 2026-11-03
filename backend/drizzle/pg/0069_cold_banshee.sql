CREATE TABLE "admin_tfpolicy_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"official" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"beta" boolean DEFAULT false NOT NULL,
	"deprecated" boolean DEFAULT false NOT NULL,
	"deprecated_reason" text,
	"archs" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "admin_tfpolicy_versions_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "policy_set_stacks" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_set_id" text NOT NULL,
	"stack_id" text NOT NULL,
	"is_exclude" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "ado_org_name" text;--> statement-breakpoint
ALTER TABLE "policy_sets" ADD COLUMN "tag_match_logic" text DEFAULT 'any';--> statement-breakpoint
ALTER TABLE "registry_components" ADD COLUMN "tag_bindings" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "registry_modules" ADD COLUMN "tag_bindings" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "registry_providers" ADD COLUMN "tag_bindings" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_set_stacks" ADD CONSTRAINT "policy_set_stacks_policy_set_id_policy_sets_id_fk" FOREIGN KEY ("policy_set_id") REFERENCES "public"."policy_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_set_stacks" ADD CONSTRAINT "policy_set_stacks_stack_id_stacks_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."stacks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "policy_set_stacks_idx" ON "policy_set_stacks" USING btree ("policy_set_id","stack_id");