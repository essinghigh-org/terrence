ALTER TABLE organizations ADD COLUMN aggregated_commit_status_enabled INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN send_passing_statuses INTEGER NOT NULL DEFAULT 0;
