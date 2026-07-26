-- Add new fields to runs table for Epic 9 run modes
ALTER TABLE runs ADD COLUMN allow_empty_apply integer DEFAULT false NOT NULL;
ALTER TABLE runs ADD COLUMN save_plan integer DEFAULT false NOT NULL;
ALTER TABLE runs ADD COLUMN allow_config_generation integer DEFAULT false NOT NULL;
ALTER TABLE runs ADD COLUMN status_timestamps text;
ALTER TABLE runs ADD COLUMN plan_resource_additions integer DEFAULT 0;
ALTER TABLE runs ADD COLUMN plan_resource_changes integer DEFAULT 0;
ALTER TABLE runs ADD COLUMN plan_resource_destructions integer DEFAULT 0;
ALTER TABLE runs ADD COLUMN apply_resource_additions integer DEFAULT 0;
ALTER TABLE runs ADD COLUMN apply_resource_changes integer DEFAULT 0;
ALTER TABLE runs ADD COLUMN apply_resource_destructions integer DEFAULT 0;
