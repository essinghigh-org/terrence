ALTER TABLE `organizations` ADD `require_hard_isolation` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `trusted_execution` integer DEFAULT true NOT NULL;