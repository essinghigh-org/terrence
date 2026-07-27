-- Add created_at columns to workspaces and state_versions
ALTER TABLE workspaces ADD COLUMN created_at integer NOT NULL DEFAULT (strftime('%s', 'now') * 1000);
ALTER TABLE state_versions ADD COLUMN created_at integer NOT NULL DEFAULT (strftime('%s', 'now') * 1000);
