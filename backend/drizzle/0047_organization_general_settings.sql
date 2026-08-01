-- Organization General settings (TFE parity): notification email, force-delete
-- workspace policy, Stacks toggle, Terraform pre-release visibility, and the
-- organizational default execution mode.
ALTER TABLE organizations ADD COLUMN email TEXT;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN allow_force_delete_workspaces INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN stacks_enabled INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN show_pre_releases INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN default_execution_mode TEXT DEFAULT 'remote';
