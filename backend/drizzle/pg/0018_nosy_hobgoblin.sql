ALTER TABLE "notification_configurations" ALTER COLUMN "enabled" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "default_iac_binary" SET DEFAULT 'terraform';--> statement-breakpoint
ALTER TABLE "policy_sets" ALTER COLUMN "overridable" SET DEFAULT false;