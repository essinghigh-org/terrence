-- Repair databases that applied the squashed baseline before the explain
-- feature was added. The baseline contains this table for fresh installs;
-- IF NOT EXISTS keeps this upgrade safe for both database shapes.
CREATE TABLE IF NOT EXISTS `run_explanations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`model` text NOT NULL,
	`content` text NOT NULL,
	`thinking` text,
	`input_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `run_explanations_run_kind_idx` ON `run_explanations` (`run_id`,`kind`);
