-- Project-owned variable sets: a variable set may be owned by a project
-- (parent_project_id) rather than the organization. TFE models this as the
-- parent relationship on tfe_variable_set (parent_project_id); org-owned
-- sets keep this column NULL.
ALTER TABLE variable_sets ADD COLUMN parent_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS variable_sets_parent_project_idx ON variable_sets(parent_project_id);
