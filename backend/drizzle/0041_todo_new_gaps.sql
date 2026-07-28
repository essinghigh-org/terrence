ALTER TABLE users ADD COLUMN is_site_auditor INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN is_suspended INTEGER DEFAULT 0;
ALTER TABLE teams ADD COLUMN allow_member_token_management INTEGER DEFAULT 0;
ALTER TABLE oauth_clients ADD COLUMN organization_scoped INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS workspace_transfers (
  id TEXT PRIMARY KEY,
  source_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  destination_org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  destination_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  approval_mode TEXT NOT NULL DEFAULT 'auto',
  cleanup_on_failure INTEGER DEFAULT 1,
  history_cutoff TEXT,
  policy_set_mode TEXT NOT NULL DEFAULT 'move',
  variable_mode TEXT NOT NULL DEFAULT 'move',
  workspace_prefix TEXT,
  workspace_suffix TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  pause_reason TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_exports (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  data_type TEXT NOT NULL DEFAULT 'sentinel-mock-bundle-v0',
  status TEXT NOT NULL DEFAULT 'queued',
  download_url TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cidr_range_lists (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  enforcement_scope TEXT NOT NULL DEFAULT 'organization',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cidr_ranges (
  id TEXT PRIMARY KEY,
  cidr_range_list_id TEXT NOT NULL REFERENCES cidr_range_lists(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS query_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'tfe-api',
  variables TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  log_read_url TEXT,
  status_timestamps TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  canceled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS team_projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  access TEXT NOT NULL DEFAULT 'read',
  project_access TEXT,
  workspace_access TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(team_id, project_id)
);

CREATE TABLE IF NOT EXISTS admin_general_settings (
  id TEXT PRIMARY KEY,
  limit_user_organization_creation INTEGER NOT NULL DEFAULT 1,
  api_rate_limiting_enabled INTEGER NOT NULL DEFAULT 1,
  api_rate_limit INTEGER NOT NULL DEFAULT 30,
  plan_timeout TEXT NOT NULL DEFAULT '2h',
  apply_timeout TEXT NOT NULL DEFAULT '24h',
  send_passing_statuses INTEGER NOT NULL DEFAULT 0,
  allow_speculative_plans_forks INTEGER NOT NULL DEFAULT 0,
  default_remote_state_access INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
