CREATE TABLE `run_provenance_capsules` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`public_manifest` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`execution_material` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_provenance_capsules_run_idx` ON `run_provenance_capsules` (`run_id`);