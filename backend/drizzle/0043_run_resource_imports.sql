ALTER TABLE runs ADD COLUMN plan_resource_imports integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN apply_resource_imports integer DEFAULT 0;
