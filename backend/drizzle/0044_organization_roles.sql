CREATE TABLE IF NOT EXISTS organization_roles (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  permissions TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(org_id, name)
);
CREATE TABLE IF NOT EXISTS organization_membership_roles (
  membership_id TEXT NOT NULL REFERENCES organization_memberships(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES organization_roles(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(membership_id, role_id)
);
---
-- Additive RBAC tables; existing team and organization permissions remain authoritative.
---
SELECT 1;
